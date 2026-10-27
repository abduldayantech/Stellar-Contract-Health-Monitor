import type {
  AlertSeverity,
  EventMatchConfig,
  InactivityConfig,
  TtlExpiryConfig,
  ValueCondition,
} from '@stellar-health/shared-types';
import { AVG_LEDGER_SECONDS } from '@stellar-health/shared-types';
import { matchTopics } from './topics';

export interface EventLike {
  eventId: string;
  topics: string[];
  ledger: number;
  ledgerClosedAt: Date;
  txHash: string;
  inSuccessfulContractCall: boolean;
  /** Decoded event value (JSON-safe; i128/u128 as decimal strings). */
  value?: unknown;
}

/** Follows a dot-separated path into a decoded value; "" returns the value itself. */
export function valueAtPath(value: unknown, path: string): unknown {
  if (!path) return value;
  let current: unknown = value;
  for (const key of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** Reads integers from numbers or decimal strings without losing precision. */
export function toBigInt(value: unknown): bigint | null {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return Number.isSafeInteger(value) ? BigInt(value) : null;
  if (typeof value === 'string' && /^-?\d{1,80}$/.test(value.trim())) return BigInt(value.trim());
  return null;
}

/** True when the value at `path` is an integer satisfying the comparison. */
export function matchesValueCondition(condition: ValueCondition, value: unknown): boolean {
  const actual = toBigInt(valueAtPath(value, condition.path));
  if (actual === null) return false;
  const expected = BigInt(condition.value);
  switch (condition.op) {
    case 'gt':
      return actual > expected;
    case 'gte':
      return actual >= expected;
    case 'lt':
      return actual < expected;
    case 'lte':
      return actual <= expected;
    case 'eq':
      return actual === expected;
  }
}

export function eventMatches(config: EventMatchConfig, event: EventLike): boolean {
  if (!config.includeFailedCalls && !event.inSuccessfulContractCall) return false;
  if (!matchTopics(config.topics, event.topics)) return false;
  return !config.valueCondition || matchesValueCondition(config.valueCondition, event.value);
}

export interface EventMatchResult {
  /** Newly ingested events that matched the rule. */
  matched: EventLike[];
  /** Matching events inside the rule window (including the new ones). */
  windowCount: number;
  triggered: boolean;
}

/**
 * Evaluates an EVENT_MATCH rule against a batch of newly ingested events.
 * `windowEvents` should contain all events of the contract inside the rule window
 * (new events may be included; duplicates by eventId are ignored).
 */
export function evaluateEventMatch(params: {
  config: EventMatchConfig;
  newEvents: EventLike[];
  windowEvents: EventLike[];
  now: Date;
}): EventMatchResult {
  const { config, newEvents, windowEvents, now } = params;
  const matched = newEvents.filter((e) => eventMatches(config, e));
  if (matched.length === 0) return { matched, windowCount: 0, triggered: false };

  const windowStart = now.getTime() - config.windowSeconds * 1000;
  const seen = new Set<string>();
  let windowCount = 0;
  for (const e of [...windowEvents, ...matched]) {
    if (seen.has(e.eventId)) continue;
    seen.add(e.eventId);
    if (e.ledgerClosedAt.getTime() >= windowStart && eventMatches(config, e)) windowCount++;
  }
  return { matched, windowCount, triggered: windowCount >= config.threshold };
}

export interface TtlEntryLike {
  id: string;
  label: string;
  kind: string;
  exists: boolean;
  liveUntilLedger: number | null;
}

export interface TtlBreach {
  entry: TtlEntryLike;
  ledgersRemaining: number;
  /** Rough wall-clock estimate using the average ledger close time. */
  secondsRemaining: number;
  /** True if the entry is already archived/expired (or missing). */
  expired: boolean;
}

export function ledgersRemaining(liveUntilLedger: number, latestLedger: number): number {
  return liveUntilLedger - latestLedger;
}

export function evaluateTtl(params: {
  config: TtlExpiryConfig;
  entries: TtlEntryLike[];
  latestLedger: number;
}): TtlBreach[] {
  const breaches: TtlBreach[] = [];
  for (const entry of params.entries) {
    if (!entry.exists || entry.liveUntilLedger === null) {
      // Missing entries are reported as expired: the contract can no longer read them without restore.
      breaches.push({ entry, ledgersRemaining: 0, secondsRemaining: 0, expired: true });
      continue;
    }
    const remaining = ledgersRemaining(entry.liveUntilLedger, params.latestLedger);
    if (remaining <= params.config.ledgersThreshold) {
      breaches.push({
        entry,
        ledgersRemaining: Math.max(0, remaining),
        secondsRemaining: Math.max(0, remaining) * AVG_LEDGER_SECONDS,
        expired: remaining < 0,
      });
    }
  }
  return breaches.sort((a, b) => a.ledgersRemaining - b.ledgersRemaining);
}

export function evaluateInactivity(params: {
  config: InactivityConfig;
  lastEventAt: Date | null;
  /** When monitoring of this contract began; inactivity is measured from here if there are no events. */
  monitoringSince: Date;
  now: Date;
}): { inactive: boolean; idleSeconds: number } {
  const reference = params.lastEventAt ?? params.monitoringSince;
  const idleSeconds = Math.max(0, Math.floor((params.now.getTime() - reference.getTime()) / 1000));
  return { inactive: idleSeconds >= params.config.windowSeconds, idleSeconds };
}

export function isCoolingDown(
  lastTriggeredAt: Date | null,
  cooldownSeconds: number,
  now: Date,
): boolean {
  if (!lastTriggeredAt || cooldownSeconds <= 0) return false;
  return now.getTime() - lastTriggeredAt.getTime() < cooldownSeconds * 1000;
}

export type LevelTransition = 'trigger' | 'resolve' | 'none';

/**
 * For condition-based rules (TTL, inactivity) an alert stays open while the condition holds,
 * and is resolved once it clears. This avoids re-alerting every evaluation cycle.
 */
export function decideLevelTransition(params: {
  conditionActive: boolean;
  hasOpenAlert: boolean;
  coolingDown: boolean;
}): LevelTransition {
  if (params.conditionActive && !params.hasOpenAlert && !params.coolingDown) return 'trigger';
  if (!params.conditionActive && params.hasOpenAlert) return 'resolve';
  return 'none';
}

/** Escalates TTL alerts to CRITICAL when an entry has already expired. */
export function ttlSeverity(base: AlertSeverity, breaches: TtlBreach[]): AlertSeverity {
  return breaches.some((b) => b.expired) ? 'CRITICAL' : base;
}
