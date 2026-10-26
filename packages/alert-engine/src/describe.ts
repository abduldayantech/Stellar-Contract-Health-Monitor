import { AVG_LEDGER_SECONDS } from '@stellar-health/shared-types';
import type { EventLike, TtlBreach } from './evaluate';

export interface AlertDescription {
  title: string;
  message: string;
  context: Record<string, unknown>;
}

interface ContractRef {
  contractId: string;
  label: string | null;
  network: string;
}

function contractName(c: ContractRef): string {
  return c.label ? `${c.label} (${shortId(c.contractId)})` : shortId(c.contractId);
}

export function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id;
}

export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

export function describeEventMatch(params: {
  ruleName: string;
  contract: ContractRef;
  matched: EventLike[];
  windowCount: number;
  threshold: number;
  windowSeconds: number;
}): AlertDescription {
  const { contract, matched, windowCount, threshold, windowSeconds } = params;
  const first = matched[0];
  // Long values (G.../C... addresses, hashes) are shortened so titles stay readable in emails and lists.
  const topicText =
    first && first.topics.length > 0
      ? first.topics.map((t) => (t.length > 20 ? shortId(t) : t)).join(' / ')
      : 'event';
  const title =
    threshold > 1
      ? `${windowCount} matching events in ${formatDuration(windowSeconds)} on ${contractName(contract)}`
      : `${topicText} on ${contractName(contract)}`;
  const message =
    threshold > 1
      ? `Rule "${params.ruleName}" saw ${windowCount} matching events within ${formatDuration(windowSeconds)} (threshold ${threshold}).`
      : `Rule "${params.ruleName}" matched ${matched.length} new event${matched.length === 1 ? '' : 's'} on ${contract.network.toLowerCase()}.`;
  return {
    title,
    message,
    context: {
      windowCount,
      threshold,
      windowSeconds,
      events: matched.slice(0, 20).map((e) => ({
        eventId: e.eventId,
        ledger: e.ledger,
        ledgerClosedAt: e.ledgerClosedAt.toISOString(),
        txHash: e.txHash,
        topics: e.topics,
      })),
      truncated: matched.length > 20,
    },
  };
}

export function describeTtl(params: {
  ruleName: string;
  contract: ContractRef;
  breaches: TtlBreach[];
  latestLedger: number;
  ledgersThreshold: number;
  /** `stellar contract extend` command per entry ID, shown for entries that are still live. */
  extendCommands?: Record<string, string>;
}): AlertDescription {
  const { contract, breaches } = params;
  const commands = params.extendCommands ?? {};
  const worst = breaches[0];
  const expiredCount = breaches.filter((b) => b.expired).length;
  const title =
    expiredCount > 0
      ? `${expiredCount} storage entr${expiredCount === 1 ? 'y has' : 'ies have'} expired on ${contractName(contract)}`
      : `Storage expiring in ~${formatDuration(worst?.secondsRemaining ?? 0)} on ${contractName(contract)}`;
  const lines = breaches.map((b) => {
    if (b.expired) return `• ${b.entry.label}: expired or archived`;
    const line = `• ${b.entry.label}: ${b.ledgersRemaining} ledgers (~${formatDuration(b.ledgersRemaining * AVG_LEDGER_SECONDS)}) left`;
    const command = commands[b.entry.id];
    return command ? `${line}\n  ${command}` : line;
  });
  const hasCommands = breaches.some((b) => !b.expired && commands[b.entry.id]);
  return {
    title,
    message: `Rule "${params.ruleName}" (threshold ${params.ledgersThreshold} ledgers):\n${lines.join('\n')}\n${
      hasCommands
        ? 'Run the commands above with your own identity to extend the TTL and keep these entries live.'
        : 'Extend the TTL (e.g. `stellar contract extend`) to keep these entries live.'
    }`,
    context: {
      latestLedger: params.latestLedger,
      ledgersThreshold: params.ledgersThreshold,
      entries: breaches.map((b) => ({
        id: b.entry.id,
        label: b.entry.label,
        kind: b.entry.kind,
        liveUntilLedger: b.entry.liveUntilLedger,
        ledgersRemaining: b.ledgersRemaining,
        expired: b.expired,
        ...(commands[b.entry.id] && !b.expired ? { extendCommand: commands[b.entry.id] } : {}),
      })),
    },
  };
}

export function describeInactivity(params: {
  ruleName: string;
  contract: ContractRef;
  idleSeconds: number;
  windowSeconds: number;
  lastEventAt: Date | null;
}): AlertDescription {
  return {
    title: `No events for ${formatDuration(params.idleSeconds)} on ${contractName(params.contract)}`,
    message: `Rule "${params.ruleName}" expects activity at least every ${formatDuration(params.windowSeconds)}. Last event: ${params.lastEventAt ? params.lastEventAt.toISOString() : 'none since monitoring started'}.`,
    context: {
      idleSeconds: params.idleSeconds,
      windowSeconds: params.windowSeconds,
      lastEventAt: params.lastEventAt?.toISOString() ?? null,
    },
  };
}
