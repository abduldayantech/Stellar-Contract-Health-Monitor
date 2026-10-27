import { eventMatchConfigSchema } from '@stellar-health/shared-types';
import { describe, expect, it } from 'vitest';
import {
  decideLevelTransition,
  describeEventMatch,
  describeTtl,
  describeWasmChanged,
  evaluateEventMatch,
  evaluateInactivity,
  evaluateTtl,
  formatDuration,
  isCoolingDown,
  matchesValueCondition,
  matchTopics,
  toBigInt,
  valueAtPath,
  ttlSeverity,
  type EventLike,
} from '../src';

const now = new Date('2026-01-01T12:00:00Z');
let seq = 0;
function ev(topics: string[], secondsAgo = 0, ok = true): EventLike {
  seq++;
  return {
    eventId: `000${seq}-0`,
    topics,
    ledger: 1000 + seq,
    ledgerClosedAt: new Date(now.getTime() - secondsAgo * 1000),
    txHash: 'ab'.repeat(32),
    inSuccessfulContractCall: ok,
  };
}

describe('matchTopics', () => {
  it('matches everything with an empty filter', () => {
    expect(matchTopics([], ['transfer', 'a', 'b'])).toBe(true);
    expect(matchTopics([], [])).toBe(true);
  });
  it('treats shorter filters as prefixes', () => {
    expect(matchTopics(['transfer'], ['transfer', 'a', 'b'])).toBe(true);
    expect(matchTopics(['mint'], ['transfer', 'a'])).toBe(false);
  });
  it('supports * wildcards', () => {
    expect(matchTopics(['transfer', '*', 'GABC'], ['transfer', 'x', 'GABC'])).toBe(true);
    expect(matchTopics(['transfer', '*', 'GABC'], ['transfer', 'x', 'GXYZ'])).toBe(false);
  });
  it('requires a topic to exist at wildcard positions', () => {
    expect(matchTopics(['transfer', '*'], ['transfer'])).toBe(false);
  });
  it('supports trailing **', () => {
    expect(matchTopics(['transfer', '**'], ['transfer'])).toBe(true);
  });
});

describe('evaluateEventMatch', () => {
  const config = eventMatchConfigSchema.parse({ topics: ['transfer'] });

  it('triggers on a single matching event with default threshold', () => {
    const e = ev(['transfer', 'a', 'b']);
    const r = evaluateEventMatch({ config, newEvents: [e, ev(['mint'])], windowEvents: [e], now });
    expect(r.triggered).toBe(true);
    expect(r.matched).toHaveLength(1);
  });

  it('ignores failed calls unless configured', () => {
    const failed = ev(['transfer'], 0, false);
    expect(
      evaluateEventMatch({ config, newEvents: [failed], windowEvents: [], now }).triggered,
    ).toBe(false);
    const incl = eventMatchConfigSchema.parse({ topics: ['transfer'], includeFailedCalls: true });
    expect(
      evaluateEventMatch({ config: incl, newEvents: [failed], windowEvents: [], now }).triggered,
    ).toBe(true);
  });

  it('applies the threshold within the window, counting each event once', () => {
    const cfg = eventMatchConfigSchema.parse({
      topics: ['transfer'],
      threshold: 3,
      windowSeconds: 60,
    });
    const old = ev(['transfer'], 30);
    const tooOld = ev(['transfer'], 600);
    const fresh = ev(['transfer']);
    const r1 = evaluateEventMatch({
      config: cfg,
      newEvents: [fresh],
      windowEvents: [old, tooOld, fresh],
      now,
    });
    expect(r1).toMatchObject({ windowCount: 2, triggered: false });
    const fresh2 = ev(['transfer']);
    const r2 = evaluateEventMatch({
      config: cfg,
      newEvents: [fresh2],
      windowEvents: [old, fresh],
      now,
    });
    expect(r2).toMatchObject({ windowCount: 3, triggered: true });
  });

  it('does nothing without matches', () => {
    expect(
      evaluateEventMatch({ config, newEvents: [ev(['mint'])], windowEvents: [], now }).triggered,
    ).toBe(false);
  });
});

describe('value conditions', () => {
  it('reads nested fields, including array indexes', () => {
    const value = { amount: '5', to: { id: 'G1' }, list: [{ amount: 7 }] };
    expect(valueAtPath(value, '')).toBe(value);
    expect(valueAtPath(value, 'amount')).toBe('5');
    expect(valueAtPath(value, 'to.id')).toBe('G1');
    expect(valueAtPath(value, 'list.0.amount')).toBe(7);
    expect(valueAtPath(value, 'missing.deeper')).toBeUndefined();
    expect(valueAtPath('scalar', 'amount')).toBeUndefined();
  });

  it('converts integers exactly and rejects everything else', () => {
    // i128 amounts arrive as decimal strings beyond Number.MAX_SAFE_INTEGER.
    expect(toBigInt('170141183460469231731687303715884105727')).toBe(
      170141183460469231731687303715884105727n,
    );
    expect(toBigInt(' -42 ')).toBe(-42n);
    expect(toBigInt(12)).toBe(12n);
    expect(toBigInt(2 ** 60)).toBeNull();
    expect(toBigInt(1.5)).toBeNull();
    expect(toBigInt('1e9')).toBeNull();
    expect(toBigInt({ amount: 1 })).toBeNull();
    expect(toBigInt(null)).toBeNull();
  });

  it('compares with every operator and never matches non-numeric values', () => {
    const big = '100000000000000000000';
    const at = (op: 'gt' | 'gte' | 'lt' | 'lte' | 'eq', value: string, actual: unknown) =>
      matchesValueCondition({ path: 'amount', op, value }, { amount: actual });
    expect(at('gt', big, '100000000000000000001')).toBe(true);
    expect(at('gt', big, big)).toBe(false);
    expect(at('gte', big, big)).toBe(true);
    expect(at('lt', '0', '-1')).toBe(true);
    expect(at('lte', '0', '1')).toBe(false);
    expect(at('eq', '7', 7)).toBe(true);
    expect(at('gt', '0', 'not a number')).toBe(false);
    expect(at('gt', '0', undefined)).toBe(false);
  });

  it('applies the condition on top of the topic filter', () => {
    const config = eventMatchConfigSchema.parse({
      topics: ['transfer'],
      valueCondition: { path: 'amount', op: 'gte', value: '1000' },
    });
    const result = evaluateEventMatch({
      config,
      newEvents: [
        { ...ev(['transfer']), value: { amount: '999' } },
        { ...ev(['transfer']), value: { amount: '1000' } },
        { ...ev(['mint']), value: { amount: '5000' } },
      ],
      windowEvents: [],
      now,
    });
    expect(result.triggered).toBe(true);
    expect(result.matched).toHaveLength(1);
  });
});

describe('evaluateTtl', () => {
  const entries = [
    { id: '1', label: 'Instance', kind: 'INSTANCE', exists: true, liveUntilLedger: 1100 },
    { id: '2', label: 'Code', kind: 'CODE', exists: true, liveUntilLedger: 100_000 },
    { id: '3', label: 'Admin', kind: 'PERSISTENT', exists: false, liveUntilLedger: null },
    { id: '4', label: 'Balance', kind: 'PERSISTENT', exists: true, liveUntilLedger: 900 },
  ];

  it('returns entries under the threshold, worst first', () => {
    const r = evaluateTtl({ config: { ledgersThreshold: 500 }, entries, latestLedger: 1000 });
    expect(r.map((b) => b.entry.id)).toEqual(['3', '4', '1']);
    expect(r.find((b) => b.entry.id === '1')).toMatchObject({
      ledgersRemaining: 100,
      secondsRemaining: 500,
      expired: false,
    });
    expect(r.find((b) => b.entry.id === '4')).toMatchObject({ ledgersRemaining: 0, expired: true });
  });

  it('escalates severity when something expired', () => {
    const r = evaluateTtl({ config: { ledgersThreshold: 500 }, entries, latestLedger: 1000 });
    expect(ttlSeverity('WARNING', r)).toBe('CRITICAL');
    expect(
      ttlSeverity(
        'WARNING',
        r.filter((b) => !b.expired),
      ),
    ).toBe('WARNING');
  });

  it('describes breaches', () => {
    const r = evaluateTtl({
      config: { ledgersThreshold: 500 },
      entries: entries.slice(0, 1),
      latestLedger: 1000,
    });
    const d = describeTtl({
      ruleName: 'ttl',
      contract: { contractId: 'C'.repeat(56), label: 'Token', network: 'TESTNET' },
      breaches: r,
      latestLedger: 1000,
      ledgersThreshold: 500,
    });
    expect(d.title).toContain('Storage expiring in ~8m');
    expect(d.message).toContain('Instance: 100 ledgers');
  });

  it('includes the extend command for live entries', () => {
    const r = evaluateTtl({ config: { ledgersThreshold: 500 }, entries, latestLedger: 1000 });
    const command = 'stellar contract extend --id CX --ledgers-to-extend 535679';
    const d = describeTtl({
      ruleName: 'ttl',
      contract: { contractId: 'C'.repeat(56), label: 'Token', network: 'TESTNET' },
      breaches: r,
      latestLedger: 1000,
      ledgersThreshold: 500,
      extendCommands: Object.fromEntries(entries.map((e) => [e.id, command])),
    });
    expect(d.message).toContain(`Instance: 100 ledgers (~8m) left\n  ${command}`);
    const ctx = d.context.entries as { expired: boolean; extendCommand?: string }[];
    expect(ctx.filter((e) => e.extendCommand)).toHaveLength(r.filter((b) => !b.expired).length);
    expect(ctx.find((e) => e.expired)?.extendCommand).toBeUndefined();
  });
});

describe('evaluateInactivity', () => {
  it('measures from the last event', () => {
    const r = evaluateInactivity({
      config: { windowSeconds: 3600 },
      lastEventAt: new Date(now.getTime() - 7200_000),
      monitoringSince: new Date(0),
      now,
    });
    expect(r).toEqual({ inactive: true, idleSeconds: 7200 });
  });
  it('measures from monitoring start when there are no events', () => {
    const r = evaluateInactivity({
      config: { windowSeconds: 3600 },
      lastEventAt: null,
      monitoringSince: new Date(now.getTime() - 60_000),
      now,
    });
    expect(r.inactive).toBe(false);
  });
});

describe('cooldown and level transitions', () => {
  it('respects cooldown', () => {
    expect(isCoolingDown(new Date(now.getTime() - 10_000), 60, now)).toBe(true);
    expect(isCoolingDown(new Date(now.getTime() - 120_000), 60, now)).toBe(false);
    expect(isCoolingDown(null, 60, now)).toBe(false);
    expect(isCoolingDown(new Date(now.getTime()), 0, now)).toBe(false);
  });
  it('opens and resolves level alerts', () => {
    expect(
      decideLevelTransition({ conditionActive: true, hasOpenAlert: false, coolingDown: false }),
    ).toBe('trigger');
    expect(
      decideLevelTransition({ conditionActive: true, hasOpenAlert: true, coolingDown: false }),
    ).toBe('none');
    expect(
      decideLevelTransition({ conditionActive: true, hasOpenAlert: false, coolingDown: true }),
    ).toBe('none');
    expect(
      decideLevelTransition({ conditionActive: false, hasOpenAlert: true, coolingDown: false }),
    ).toBe('resolve');
    expect(
      decideLevelTransition({ conditionActive: false, hasOpenAlert: false, coolingDown: false }),
    ).toBe('none');
  });
});

describe('descriptions', () => {
  it('formats durations', () => {
    expect(formatDuration(45)).toBe('45s');
    expect(formatDuration(3660)).toBe('1h 1m');
    expect(formatDuration(90000)).toBe('1d 1h');
  });
  it('describes event matches', () => {
    const d = describeEventMatch({
      ruleName: 'Transfers',
      contract: {
        contractId: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
        label: null,
        network: 'TESTNET',
      },
      matched: [ev(['transfer', 'a'])],
      windowCount: 1,
      threshold: 1,
      windowSeconds: 60,
    });
    expect(d.title).toBe('transfer / a on CDLZFC…CYSC');
    expect((d.context.events as unknown[]).length).toBe(1);
  });

  it('shortens long topic values such as addresses in titles', () => {
    const addr = 'GAGVZMODPYFTULIVSY3RGFADIC5LF4LLSN37N4MFWGNZ57TYBXL2LQQX';
    const d = describeEventMatch({
      ruleName: 'Transfers',
      contract: {
        contractId: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
        label: 'XLM',
        network: 'TESTNET',
      },
      matched: [ev(['transfer', addr])],
      windowCount: 1,
      threshold: 1,
      windowSeconds: 60,
    });
    expect(d.title).toBe('transfer / GAGVZM…LQQX on XLM (CDLZFC…CYSC)');
    // Full values stay available in the context for webhook consumers.
    expect(JSON.stringify(d.context)).toContain(addr);
  });
});

describe('describeWasmChanged', () => {
  it('names the contract and both hashes', () => {
    const d = describeWasmChanged({
      ruleName: 'Upgrades',
      contract: { contractId: 'C'.repeat(56), label: 'Token', network: 'MAINNET' },
      previousWasmHash: 'aa'.repeat(32),
      newWasmHash: 'bb'.repeat(32),
      latestLedger: 123,
    });
    expect(d.title).toBe('Contract WASM upgraded on Token (CCCCCC…CCCC)');
    expect(d.message).toContain(`now runs WASM ${'bb'.repeat(32)} (was ${'aa'.repeat(32)})`);
    expect(d.message).toContain('mainnet');
    expect(d.context).toEqual({
      previousWasmHash: 'aa'.repeat(32),
      newWasmHash: 'bb'.repeat(32),
      detectedAtLedger: 123,
    });
  });
});
