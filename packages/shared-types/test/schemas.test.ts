import { describe, expect, it } from 'vitest';
import {
  createAlertRuleSchema,
  createDestinationSchema,
  listEventsQuerySchema,
  parseRuleConfig,
  topicFilterSchema,
} from '../src';

describe('alert rule schemas', () => {
  it('applies per-type defaults', () => {
    expect(parseRuleConfig('EVENT_MATCH', undefined)).toEqual({
      type: 'EVENT_MATCH',
      config: { topics: [], threshold: 1, windowSeconds: 300, includeFailedCalls: false },
    });
    expect(parseRuleConfig('TTL_EXPIRY', {}).config).toEqual({ ledgersThreshold: 17_280 * 7 });
    expect(parseRuleConfig('INACTIVITY', {}).config).toEqual({ windowSeconds: 86_400 });
    expect(() => parseRuleConfig('NOPE', {})).toThrow(/Unknown alert rule type/);
  });

  it('limits topic filters to four positions', () => {
    expect(topicFilterSchema.safeParse(['a', 'b', 'c', 'd']).success).toBe(true);
    expect(topicFilterSchema.safeParse(['a', 'b', 'c', 'd', 'e']).success).toBe(false);
    expect(topicFilterSchema.safeParse(['']).success).toBe(false);
  });

  it('validates the config for the chosen rule type', () => {
    const base = { name: 'r', contractRefId: null };
    expect(
      createAlertRuleSchema.safeParse({
        ...base,
        type: 'INACTIVITY',
        config: { windowSeconds: 10 },
      }).success,
    ).toBe(false);
    const withValue = (valueCondition: unknown) =>
      createAlertRuleSchema.safeParse({ ...base, type: 'EVENT_MATCH', config: { valueCondition } })
        .success;
    expect(
      withValue({ path: 'amount', op: 'gt', value: '170141183460469231731687303715884105727' }),
    ).toBe(true);
    expect(withValue({ op: 'eq', value: '-5' })).toBe(true);
    expect(withValue({ path: 'amount', op: 'gt', value: '1.5' })).toBe(false);
    expect(withValue({ path: 'amount', op: 'between', value: '1' })).toBe(false);
    expect(withValue({ path: 'a..b', op: 'gt', value: '1' })).toBe(false);
    const ok = createAlertRuleSchema.parse({ ...base, type: 'TTL_EXPIRY', config: {} });
    expect(ok).toMatchObject({
      enabled: true,
      severity: 'WARNING',
      cooldownSeconds: 300,
      destinationIds: [],
    });
  });
});

describe('destination schemas', () => {
  it('accepts http(s) webhooks only', () => {
    const hook = (url: string) =>
      createDestinationSchema.safeParse({ type: 'WEBHOOK', name: 'h', config: { url } }).success;
    expect(hook('https://example.com/x')).toBe(true);
    expect(hook('http://example.com/x')).toBe(true);
    expect(hook('javascript:alert(1)')).toBe(false);
    expect(hook('ftp://example.com')).toBe(false);
  });

  it('requires at least one valid email', () => {
    const email = (to: string[]) =>
      createDestinationSchema.safeParse({ type: 'EMAIL', name: 'e', config: { to } }).success;
    expect(email(['a@example.com'])).toBe(true);
    expect(email([])).toBe(false);
    expect(email(['nope'])).toBe(false);
  });
});

describe('listEventsQuerySchema', () => {
  it('coerces query strings and bounds the page size', () => {
    const q = listEventsQuerySchema.parse({ limit: '20', from: '2026-01-01T00:00:00Z' });
    expect(q.limit).toBe(20);
    expect(q.from).toBeInstanceOf(Date);
    expect(listEventsQuerySchema.parse({}).limit).toBe(50);
    expect(listEventsQuerySchema.safeParse({ limit: '500' }).success).toBe(false);
    expect(listEventsQuerySchema.safeParse({ txHash: 'abc' }).success).toBe(false);
  });
});
