import type { Contract, Prisma } from '@stellar-health/db';
import {
  describeEventMatch,
  evaluateEventMatch,
  isCoolingDown,
  type EventLike,
} from '@stellar-health/alert-engine';
import { eventMatchConfigSchema, type Network } from '@stellar-health/shared-types';
import {
  isOutOfRetentionError,
  RpcError,
  type EventsPage,
  type NormalizedEvent,
} from '@stellar-health/stellar-client';
import { activeRulesFor, triggerAlert } from './alerts';
import type { WorkerDeps } from './deps';

export interface IngestResult {
  skipped?: 'not_found' | 'not_active';
  pages: number;
  fetched: number;
  inserted: number;
  latestLedger: number | null;
  gap: boolean;
}

/** Events older than this, relative to when a rule/contract was created, never trigger alerts (backfill). */
const BACKFILL_GRACE_MS = 60_000;

/**
 * Pulls new events for one contract, persisting them and the RPC cursor.
 *
 * RPC only retains a limited window of events (~7 days on public providers), so:
 *  - a missing cursor starts from `startLedger`, clamped to the oldest retained ledger;
 *  - a cursor that has fallen out of retention is reset to the oldest ledger and the gap is recorded.
 */
export async function ingestContract(
  deps: WorkerDeps,
  contractRefId: string,
): Promise<IngestResult> {
  const { prisma, config, metrics, logger } = deps;
  const contract = await prisma.contract.findUnique({ where: { id: contractRefId } });
  if (!contract)
    return {
      skipped: 'not_found',
      pages: 0,
      fetched: 0,
      inserted: 0,
      latestLedger: null,
      gap: false,
    };
  if (contract.status !== 'ACTIVE') {
    return {
      skipped: 'not_active',
      pages: 0,
      fetched: 0,
      inserted: 0,
      latestLedger: null,
      gap: false,
    };
  }
  const network = contract.network as Network;
  const timer = metrics.ingestDuration.labels(network).startTimer();

  try {
    const client = await deps.getClient(network);
    let cursor = contract.cursor;
    let startLedger = contract.startLedger;
    let gap = false;
    let oldestLedger: number | null = null;

    if (!cursor) {
      const health = await client.getHealth();
      oldestLedger = health.oldestLedger;
      if (startLedger <= health.oldestLedger) {
        if (contract.lastIngestedLedger !== null) gap = true;
        startLedger = health.oldestLedger + 1;
      }
    }

    const newEvents: NormalizedEvent[] = [];
    let latestLedger: number | null = null;
    let pages = 0;
    let fetched = 0;
    let resetOnce = false;
    let reachedTip = false;
    let lastPage: EventsPage | null = null;

    while (pages < config.INGEST_MAX_PAGES) {
      let page: EventsPage;
      try {
        page = cursor
          ? await client.getEvents({
              contractIds: [contract.contractId],
              cursor,
              limit: config.INGEST_PAGE_LIMIT,
            })
          : await client.getEvents({
              contractIds: [contract.contractId],
              startLedger,
              limit: config.INGEST_PAGE_LIMIT,
            });
      } catch (err) {
        const retention =
          isOutOfRetentionError(err) || (err instanceof RpcError && err.kind === 'invalid_request');
        if (!retention || resetOnce) throw err;
        // Our cursor/start ledger is no longer available: restart from the oldest retained ledger.
        resetOnce = true;
        const health = await client.getHealth();
        oldestLedger = health.oldestLedger;
        logger.warn(
          { contractRefId, err: (err as Error).message, oldest: health.oldestLedger },
          'ingestion position out of retention, resetting',
        );
        cursor = null;
        startLedger = health.oldestLedger + 1;
        gap = true;
        continue;
      }
      pages++;
      fetched += page.events.length;
      latestLedger = page.latestLedger;
      oldestLedger = page.oldestLedger;
      cursor = page.cursor || cursor;
      lastPage = page;
      newEvents.push(...(await storeEvents(deps, [contract], page.events)).get(contract.id)!);
      if (page.events.length < config.INGEST_PAGE_LIMIT) {
        reachedTip = true;
        break;
      }
    }
    const covered = coveredLedger(reachedTip, latestLedger, lastPage);

    const lastEventAt = newEvents.reduce<Date | null>(
      (max, e) => (!max || e.ledgerClosedAt > max ? e.ledgerClosedAt : max),
      contract.lastEventAt,
    );
    // Older RPC versions may not return a cursor; then advance the start ledger instead of rescanning.
    if (!cursor && latestLedger !== null) startLedger = Math.max(startLedger, latestLedger);
    const now = deps.now();
    await prisma.contract.update({
      where: { id: contract.id },
      data: {
        cursor,
        startLedger,
        lastIngestedLedger: covered ?? contract.lastIngestedLedger,
        lastPolledAt: now,
        lastEventAt,
        lastError: null,
        consecutiveFailures: 0,
        eventCount: { increment: newEvents.length },
        ...(gap ? { gapDetectedAt: now } : {}),
      },
    });
    if (latestLedger !== null) {
      await prisma.networkState.upsert({
        where: { network },
        create: { network, latestLedger, oldestLedger, lastCheckedAt: now },
        update: {
          latestLedger,
          oldestLedger: oldestLedger ?? undefined,
          lastCheckedAt: now,
          lastError: null,
        },
      });
    }

    metrics.eventsIngested.labels(network).inc(newEvents.length);
    metrics.ingestRuns.labels(network, 'ok').inc();
    if (gap) metrics.ingestionGaps.labels(network).inc();

    if (newEvents.length > 0) await evaluateEventRules(deps, contract, newEvents);

    return { pages, fetched, inserted: newEvents.length, latestLedger, gap };
  } catch (err) {
    metrics.ingestRuns.labels(network, 'error').inc();
    await prisma.contract.update({
      where: { id: contract.id },
      data: {
        lastPolledAt: deps.now(),
        lastError: (err as Error).message.slice(0, 1000),
        consecutiveFailures: { increment: 1 },
      },
    });
    throw err;
  } finally {
    timer();
  }
}

export interface BatchIngestResult {
  contracts: number;
  pages: number;
  fetched: number;
  inserted: number;
  latestLedger: number | null;
  /** Set when the batch could not run as a group and each contract was ingested on its own. */
  fallback?: 'retention' | 'single';
}

/** Stellar RPC accepts at most 5 filters of 5 contract IDs in one getEvents call. */
export const MAX_BATCH_CONTRACTS = 25;

/**
 * Ingests several caught-up contracts on one network with a single getEvents stream, cutting RPC
 * calls by up to 25x compared to polling each contract separately.
 *
 * The batch starts from the furthest-behind cursor; contracts that were already further ahead
 * see a few events again, which are de-duplicated on insert. If that position has fallen out
 * of RPC retention, every contract is ingested on its own so gaps are recorded per contract.
 */
export async function ingestBatch(
  deps: WorkerDeps,
  contractRefIds: string[],
): Promise<BatchIngestResult> {
  const { prisma, config, metrics } = deps;
  const all = await prisma.contract.findMany({
    where: { id: { in: contractRefIds.slice(0, MAX_BATCH_CONTRACTS) }, status: 'ACTIVE' },
  });
  const empty = { pages: 0, fetched: 0, inserted: 0, latestLedger: null };
  if (all.length === 0) return { contracts: 0, ...empty };

  // A batch needs one network and an existing cursor for every member.
  const network = all[0]!.network as Network;
  const contracts = all.filter((c) => c.network === network && c.cursor);
  const singles = all.filter((c) => !contracts.includes(c));
  for (const c of singles) await ingestContract(deps, c.id).catch(() => undefined);
  if (contracts.length <= 1) {
    for (const c of contracts) await ingestContract(deps, c.id);
    return { contracts: all.length, ...empty, fallback: 'single' };
  }

  const timer = metrics.ingestDuration.labels(network).startTimer();
  const fresh = new Map<string, NormalizedEvent[]>(contracts.map((c) => [c.id, []]));
  let cursor = contracts.map((c) => c.cursor!).sort()[0]!;
  let latestLedger: number | null = null;
  let oldestLedger: number | null = null;
  let pages = 0;
  let fetched = 0;
  let reachedTip = false;
  let lastPage: EventsPage | null = null;

  try {
    const client = await deps.getClient(network);
    while (pages < config.INGEST_MAX_PAGES) {
      let page: EventsPage;
      try {
        page = await client.getEvents({
          contractIds: contracts.map((c) => c.contractId),
          cursor,
          limit: config.INGEST_PAGE_LIMIT,
        });
      } catch (err) {
        const retention =
          isOutOfRetentionError(err) || (err instanceof RpcError && err.kind === 'invalid_request');
        if (!retention || pages > 0) throw err;
        for (const c of contracts) await ingestContract(deps, c.id).catch(() => undefined);
        return { contracts: all.length, ...empty, fallback: 'retention' };
      }
      pages++;
      fetched += page.events.length;
      latestLedger = page.latestLedger;
      oldestLedger = page.oldestLedger;
      cursor = page.cursor || cursor;
      lastPage = page;
      for (const [id, events] of await storeEvents(deps, contracts, page.events))
        fresh.get(id)!.push(...events);
      if (page.events.length < config.INGEST_PAGE_LIMIT) {
        reachedTip = true;
        break;
      }
    }

    const now = deps.now();
    const covered = coveredLedger(reachedTip, latestLedger, lastPage);
    // One update for the fields every member shares, then one per contract that saw new events.
    await prisma.contract.updateMany({
      where: { id: { in: contracts.map((c) => c.id) } },
      data: {
        cursor,
        ...(covered !== null ? { lastIngestedLedger: covered } : {}),
        lastPolledAt: now,
        lastError: null,
        consecutiveFailures: 0,
      },
    });
    let inserted = 0;
    for (const c of contracts) {
      const events = fresh.get(c.id)!;
      if (events.length === 0) continue;
      inserted += events.length;
      const lastEventAt = events.reduce<Date | null>(
        (max, e) => (!max || e.ledgerClosedAt > max ? e.ledgerClosedAt : max),
        c.lastEventAt,
      );
      await prisma.contract.update({
        where: { id: c.id },
        data: { lastEventAt, eventCount: { increment: events.length } },
      });
    }
    if (latestLedger !== null) {
      await prisma.networkState.upsert({
        where: { network },
        create: { network, latestLedger, oldestLedger, lastCheckedAt: now },
        update: {
          latestLedger,
          oldestLedger: oldestLedger ?? undefined,
          lastCheckedAt: now,
          lastError: null,
        },
      });
    }
    metrics.eventsIngested.labels(network).inc(inserted);
    metrics.ingestRuns.labels(network, 'ok').inc(contracts.length);

    for (const c of contracts) {
      const events = fresh.get(c.id)!;
      if (events.length > 0) await evaluateEventRules(deps, c, events);
    }
    return { contracts: all.length, pages, fetched, inserted, latestLedger };
  } catch (err) {
    metrics.ingestRuns.labels(network, 'error').inc(contracts.length);
    await prisma.contract.updateMany({
      where: { id: { in: contracts.map((c) => c.id) } },
      data: {
        lastPolledAt: deps.now(),
        lastError: (err as Error).message.slice(0, 1000),
        consecutiveFailures: { increment: 1 },
      },
    });
    throw err;
  } finally {
    timer();
  }
}

/**
 * Stores one page of events for one or more contracts in a single insert and returns, per
 * contract, only the events that were not already stored.
 */
async function storeEvents(
  deps: WorkerDeps,
  contracts: Contract[],
  events: NormalizedEvent[],
): Promise<Map<string, NormalizedEvent[]>> {
  const byContractId = new Map(contracts.map((c) => [c.contractId, c]));
  const rows: Prisma.EventCreateManyInput[] = [];
  const pending = new Map<string, NormalizedEvent>();
  for (const e of events) {
    // Events without a contract ID only make sense when polling a single contract.
    const c = e.contractId
      ? byContractId.get(e.contractId)
      : contracts.length === 1
        ? contracts[0]
        : undefined;
    if (!c) continue;
    pending.set(`${c.id}:${e.id}`, e);
    rows.push({
      contractRefId: c.id,
      eventId: e.id,
      network: c.network,
      type: e.type,
      ledger: e.ledger,
      ledgerClosedAt: e.ledgerClosedAt,
      txHash: e.txHash,
      topics: e.topics,
      topicsXdr: e.topicsXdr,
      value: (e.value ?? null) as Prisma.InputJsonValue,
      valueXdr: e.valueXdr,
      inSuccessfulContractCall: e.inSuccessfulContractCall,
    });
  }
  const fresh = new Map<string, NormalizedEvent[]>(contracts.map((c) => [c.id, []]));
  if (rows.length === 0) return fresh;
  // skipDuplicates makes re-reads (overlapping cursors, retried jobs) free; only new rows return.
  const inserted = await deps.prisma.event.createManyAndReturn({
    data: rows,
    skipDuplicates: true,
    select: { contractRefId: true, eventId: true },
  });
  for (const row of inserted) {
    const e = pending.get(`${row.contractRefId}:${row.eventId}`);
    if (e) fresh.get(row.contractRefId)!.push(e);
  }
  for (const list of fresh.values()) list.sort((a, b) => (a.id < b.id ? -1 : 1));
  return fresh;
}

/**
 * The ledger ingestion has fully covered. Only a short final page means the RPC tip was
 * reached; when the page budget ran out first, the last stored event marks how far we got.
 */
function coveredLedger(
  reachedTip: boolean,
  latestLedger: number | null,
  lastPage: EventsPage | null,
) {
  if (reachedTip || !lastPage || lastPage.events.length === 0) return latestLedger;
  // Events in the last ledger may continue on the next page, so only the one before is complete.
  return lastPage.events.at(-1)!.ledger - 1;
}

function toEventLike(e: NormalizedEvent): EventLike {
  return {
    eventId: e.id,
    topics: e.topics,
    ledger: e.ledger,
    ledgerClosedAt: e.ledgerClosedAt,
    txHash: e.txHash,
    inSuccessfulContractCall: e.inSuccessfulContractCall,
  };
}

export async function evaluateEventRules(
  deps: WorkerDeps,
  contract: Contract,
  newEvents: NormalizedEvent[],
) {
  const rules = await activeRulesFor(deps, contract.id, 'EVENT_MATCH');
  const now = deps.now();
  for (const rule of rules) {
    try {
      const config = eventMatchConfigSchema.parse(rule.config);
      // Don't alert on history that was backfilled when the contract or rule was created.
      const since =
        Math.max(contract.createdAt.getTime(), rule.createdAt.getTime()) - BACKFILL_GRACE_MS;
      const candidates = newEvents
        .filter((e) => e.ledgerClosedAt.getTime() >= since)
        .map(toEventLike);
      if (candidates.length === 0) continue;

      let windowEvents: EventLike[] = [];
      if (config.threshold > 1) {
        const rows = await deps.prisma.event.findMany({
          where: {
            contractRefId: contract.id,
            ledgerClosedAt: { gte: new Date(now.getTime() - config.windowSeconds * 1000) },
          },
          select: {
            eventId: true,
            topics: true,
            ledger: true,
            ledgerClosedAt: true,
            txHash: true,
            inSuccessfulContractCall: true,
          },
          orderBy: { ledger: 'desc' },
          take: 10_000,
        });
        windowEvents = rows;
      }

      const result = evaluateEventMatch({ config, newEvents: candidates, windowEvents, now });
      if (!result.triggered) continue;

      const state = await deps.prisma.alertRuleState.findUnique({
        where: { ruleId_contractRefId: { ruleId: rule.id, contractRefId: contract.id } },
      });
      if (isCoolingDown(state?.lastTriggeredAt ?? null, rule.cooldownSeconds, now)) {
        deps.logger.debug(
          { ruleId: rule.id, contractRefId: contract.id },
          'event rule matched during cooldown',
        );
        continue;
      }
      await triggerAlert(deps, {
        rule,
        contract,
        severity: rule.severity,
        level: false,
        description: describeEventMatch({
          ruleName: rule.name,
          contract,
          matched: result.matched,
          windowCount: result.windowCount,
          threshold: config.threshold,
          windowSeconds: config.windowSeconds,
        }),
      });
    } catch (err) {
      deps.logger.error(
        { err, ruleId: rule.id, contractRefId: contract.id },
        'failed to evaluate event rule',
      );
    }
  }
}
