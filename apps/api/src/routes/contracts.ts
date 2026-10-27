import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Prisma } from '@stellar-health/db';
import {
  createContractSchema,
  createStorageEntrySchema,
  updateContractSchema,
  validateContractSchema,
  type Network,
} from '@stellar-health/shared-types';
import {
  buildStorageKeyScVal,
  contractDataLedgerKey,
  ledgerKeyToXdr,
  validateContractId,
} from '@stellar-health/stellar-client';
import { HttpError, notFound } from '../lib/errors';
import { toPage } from '../lib/pagination';
import {
  serializeAlert,
  serializeContract,
  serializeRule,
  serializeStorageEntry,
} from '../lib/serialize';
import type { AppDeps } from '../app';

const idParams = z.object({ id: z.string().min(1) });

export async function contractRoutes(app: FastifyInstance, deps: AppDeps) {
  const { prisma, stellar, jobs, config } = deps;

  async function latestLedgers(): Promise<Map<Network, number | null>> {
    const states = await prisma.networkState.findMany();
    return new Map(states.map((s) => [s.network as Network, s.latestLedger]));
  }

  async function checkOnChain(rawId: string, network: Network) {
    const v = validateContractId(rawId);
    if (!v.valid) throw new HttpError(400, 'INVALID_CONTRACT_ID', v.reason);
    const client = await stellar(network);
    const info = await client.getContractInfo(v.contractId);
    if (!info) {
      throw new HttpError(
        422,
        'CONTRACT_NOT_FOUND',
        `No contract with ID ${v.contractId} exists on ${network.toLowerCase()} (or its instance has been archived).`,
      );
    }
    return { contractId: v.contractId, info, client };
  }

  app.post('/contracts/validate', async (req) => {
    const body = validateContractSchema.parse(req.body);
    const { contractId, info } = await checkOnChain(body.contractId, body.network);
    const existing = await prisma.contract.findUnique({
      where: { network_contractId: { network: body.network, contractId } },
      select: { id: true },
    });
    return {
      valid: true,
      contractId,
      network: body.network,
      executableType: info.executableType,
      wasmHash: info.wasmHash,
      instanceLiveUntilLedger: info.instanceLiveUntilLedger,
      codeLiveUntilLedger: info.codeLiveUntilLedger,
      latestLedger: info.latestLedger,
      alreadyRegistered: existing?.id ?? null,
    };
  });

  app.post('/contracts', async (req, reply) => {
    const body = createContractSchema.parse(req.body);
    const { contractId, info, client } = await checkOnChain(body.contractId, body.network);
    const existing = await prisma.contract.findUnique({
      where: { network_contractId: { network: body.network, contractId } },
    });
    if (existing) {
      throw new HttpError(409, 'ALREADY_REGISTERED', 'This contract is already being monitored', {
        id: existing.id,
      });
    }

    const health = await client.getHealth();
    const lookback = body.lookbackLedgers ?? config.INITIAL_LOOKBACK_LEDGERS;
    // The RPC only keeps a limited window of events; never ask for ledgers it no longer has.
    const startLedger = Math.max(health.oldestLedger + 1, health.latestLedger - lookback);

    const storageEntries: Prisma.StorageEntryCreateWithoutContractInput[] = [
      {
        kind: 'INSTANCE',
        label: 'Contract instance',
        ledgerKeyXdr: info.instanceLedgerKeyXdr,
        liveUntilLedger: info.instanceLiveUntilLedger,
        lastCheckedLedger: info.latestLedger,
        lastCheckedAt: new Date(),
      },
    ];
    if (info.codeLedgerKeyXdr) {
      storageEntries.push({
        kind: 'CODE',
        label: 'Contract code (WASM)',
        ledgerKeyXdr: info.codeLedgerKeyXdr,
        liveUntilLedger: info.codeLiveUntilLedger,
        exists: info.codeLiveUntilLedger !== null,
        lastCheckedLedger: info.latestLedger,
        lastCheckedAt: new Date(),
      });
    }

    const contract = await prisma.contract.create({
      data: {
        contractId,
        network: body.network,
        label: body.label || null,
        executableType: info.executableType,
        wasmHash: info.wasmHash,
        startLedger,
        storageEntries: { create: storageEntries },
      },
    });
    await prisma.networkState.upsert({
      where: { network: body.network },
      create: {
        network: body.network,
        latestLedger: health.latestLedger,
        oldestLedger: health.oldestLedger,
        lastCheckedAt: new Date(),
      },
      update: {
        latestLedger: health.latestLedger,
        oldestLedger: health.oldestLedger,
        lastCheckedAt: new Date(),
      },
    });
    await jobs
      .enqueueIngest(contract.id)
      .catch((err) => req.log.warn({ err }, 'failed to enqueue initial ingest'));
    reply.status(201);
    return serializeContract(contract, { latestLedger: health.latestLedger });
  });

  app.get('/contracts', async (req) => {
    const q = z
      .object({
        network: z.enum(['TESTNET', 'MAINNET', 'FUTURENET', 'LOCAL']).optional(),
        status: z.enum(['ACTIVE', 'PAUSED', 'ERROR']).optional(),
        search: z.string().max(120).optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
        cursor: z.string().optional(),
      })
      .parse(req.query);
    const rows = await prisma.contract.findMany({
      where: {
        network: q.network,
        status: q.status,
        ...(q.search
          ? {
              OR: [
                { label: { contains: q.search, mode: 'insensitive' } },
                { contractId: { contains: q.search.toUpperCase() } },
              ],
            }
          : {}),
      },
      // id breaks ties so every contract appears exactly once across pages.
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
    const { items: contracts, nextCursor } = toPage(rows, q.limit);
    const ids = contracts.map((c) => c.id);
    const [alertCounts, expiries, ledgers] = await Promise.all([
      prisma.alert.groupBy({
        by: ['contractRefId'],
        where: { contractRefId: { in: ids }, status: 'TRIGGERED' },
        _count: { _all: true },
      }),
      prisma.storageEntry.groupBy({
        by: ['contractRefId'],
        where: { contractRefId: { in: ids } },
        _min: { liveUntilLedger: true },
      }),
      latestLedgers(),
    ]);
    const alertMap = new Map(alertCounts.map((a) => [a.contractRefId, a._count._all]));
    const expiryMap = new Map(expiries.map((e) => [e.contractRefId, e._min.liveUntilLedger]));
    return {
      items: contracts.map((c) => {
        const latest = ledgers.get(c.network as Network) ?? null;
        const minLive = expiryMap.get(c.id);
        return serializeContract(c, {
          latestLedger: latest,
          openAlerts: alertMap.get(c.id) ?? 0,
          nearestExpiryLedgers: latest && minLive ? minLive - latest : null,
        });
      }),
      nextCursor,
    };
  });

  app.get('/contracts/:id', async (req) => {
    const { id } = idParams.parse(req.params);
    const c = await prisma.contract.findUnique({
      where: { id },
      include: { storageEntries: { orderBy: { createdAt: 'asc' } } },
    });
    if (!c) throw notFound('Contract');
    const [ledgers, openAlerts, rules, recentAlerts] = await Promise.all([
      latestLedgers(),
      prisma.alert.count({ where: { contractRefId: id, status: 'TRIGGERED' } }),
      prisma.alertRule.findMany({
        where: { OR: [{ contractRefId: id }, { contractRefId: null }] },
        include: { destinations: { select: { id: true, name: true, type: true } } },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.alert.findMany({
        where: { contractRefId: id },
        orderBy: { triggeredAt: 'desc' },
        take: 10,
        include: { rule: { select: { id: true, name: true, type: true } } },
      }),
    ]);
    const latest = ledgers.get(c.network as Network) ?? null;
    const entries = c.storageEntries.map((s) => serializeStorageEntry(s, latest, c.wasmHash));
    const remaining = entries.map((e) => e.ledgersRemaining).filter((r): r is number => r !== null);
    return {
      ...serializeContract(c, {
        latestLedger: latest,
        openAlerts,
        nearestExpiryLedgers: remaining.length ? Math.min(...remaining) : null,
      }),
      latestLedger: latest,
      storageEntries: entries,
      alertRules: rules.map(serializeRule),
      recentAlerts: recentAlerts.map(serializeAlert),
    };
  });

  app.get('/contracts/:id/activity', async (req) => {
    const { id } = idParams.parse(req.params);
    const { hours } = z
      .object({
        hours: z.coerce
          .number()
          .int()
          .min(1)
          .max(24 * 30)
          .default(24),
      })
      .parse(req.query);
    const exists = await prisma.contract.count({ where: { id } });
    if (!exists) throw notFound('Contract');
    const bucket = hours > 72 ? 'day' : 'hour';
    const since = new Date(Date.now() - hours * 3600_000);
    const rows = await prisma.$queryRaw<{ bucket: Date; count: bigint }[]>`
      SELECT date_trunc(${bucket}, "ledgerClosedAt") AS bucket, COUNT(*)::bigint AS count
      FROM "Event"
      WHERE "contractRefId" = ${id} AND "ledgerClosedAt" >= ${since}
      GROUP BY 1 ORDER BY 1`;
    return {
      bucket,
      since,
      points: rows.map((r) => ({ t: r.bucket, count: Number(r.count) })),
    };
  });

  app.patch('/contracts/:id', async (req) => {
    const { id } = idParams.parse(req.params);
    const body = updateContractSchema.parse(req.body);
    const data: Prisma.ContractUpdateInput = {};
    if (body.label !== undefined) data.label = body.label || null;
    if (body.status !== undefined) {
      data.status = body.status;
      if (body.status === 'ACTIVE') {
        data.consecutiveFailures = 0;
        data.lastError = null;
      }
    }
    const c = await prisma.contract.update({ where: { id }, data });
    if (c.status === 'ACTIVE') await jobs.enqueueIngest(c.id).catch(() => undefined);
    return serializeContract(c);
  });

  app.delete('/contracts/:id', async (req, reply) => {
    const { id } = idParams.parse(req.params);
    await prisma.contract.delete({ where: { id } });
    reply.status(204);
  });

  app.post('/contracts/:id/refresh', async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const c = await prisma.contract.findUnique({ where: { id }, select: { id: true } });
    if (!c) throw notFound('Contract');
    await Promise.all([jobs.enqueueIngest(id), jobs.enqueueStorageCheck(id)]);
    reply.status(202);
    return { queued: true };
  });

  app.post('/contracts/:id/storage-entries', async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const body = createStorageEntrySchema.parse(req.body);
    const c = await prisma.contract.findUnique({ where: { id } });
    if (!c) throw notFound('Contract');
    let ledgerKeyXdr: string;
    try {
      ledgerKeyXdr = ledgerKeyToXdr(
        contractDataLedgerKey(
          c.contractId,
          buildStorageKeyScVal(body.keyType, body.key),
          body.durability,
        ),
      );
    } catch {
      throw new HttpError(400, 'INVALID_KEY', 'Could not build a storage key from the given value');
    }
    const kind = body.durability === 'TEMPORARY' ? 'TEMPORARY' : 'PERSISTENT';
    const client = await stellar(c.network as Network);
    const { latestLedger, entries } = await client.getLedgerEntryTtls([ledgerKeyXdr]);
    const ttl = entries[0]!;
    const entry = await prisma.storageEntry.create({
      data: {
        contractRefId: id,
        kind,
        label: body.label,
        ledgerKeyXdr,
        exists: ttl.exists,
        liveUntilLedger: ttl.liveUntilLedger,
        lastCheckedLedger: latestLedger,
        lastCheckedAt: new Date(),
      },
    });
    reply.status(201);
    return serializeStorageEntry(entry, latestLedger);
  });

  app.delete('/contracts/:id/storage-entries/:entryId', async (req, reply) => {
    const { id, entryId } = z.object({ id: z.string(), entryId: z.string() }).parse(req.params);
    const entry = await prisma.storageEntry.findFirst({
      where: { id: entryId, contractRefId: id },
    });
    if (!entry) throw notFound('Storage entry');
    if (entry.kind === 'INSTANCE' || entry.kind === 'CODE') {
      throw new HttpError(400, 'NOT_REMOVABLE', 'Instance and code entries are always monitored');
    }
    await prisma.storageEntry.delete({ where: { id: entryId } });
    reply.status(204);
  });
}
