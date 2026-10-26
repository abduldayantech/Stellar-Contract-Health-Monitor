import { describe, expect, it } from 'vitest';
import { describeRule } from '@/lib/rules';

describe('describeRule', () => {
  it('describes each rule type', () => {
    expect(describeRule({ type: 'EVENT_MATCH', config: { topics: [] }, cooldownSeconds: 0 })).toBe(
      'On any event',
    );
    expect(
      describeRule({
        type: 'EVENT_MATCH',
        config: { topics: ['transfer', '*'], threshold: 5, windowSeconds: 600 },
        cooldownSeconds: 0,
      }),
    ).toBe('5+ events with topics [transfer, *] within 10m');
    expect(
      describeRule({ type: 'INACTIVITY', config: { windowSeconds: 7200 }, cooldownSeconds: 0 }),
    ).toBe('No events for 2h');
    expect(
      describeRule({ type: 'TTL_EXPIRY', config: { ledgersThreshold: 17280 }, cooldownSeconds: 0 }),
    ).toMatch(/^Storage with < 17,280 ledgers \(~.+\) to live$/);
    expect(describeRule({ type: 'WASM_CHANGED', config: {}, cooldownSeconds: 0 })).toBe(
      'When the contract is upgraded to a different WASM',
    );
  });
});
