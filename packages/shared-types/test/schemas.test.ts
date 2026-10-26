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

  it('accepts Slack incoming webhook URLs on hooks.slack.com over https only', () => {
    const slack = (webhookUrl: string) =>
      createDestinationSchema.safeParse({ type: 'SLACK', name: 's', config: { webhookUrl } })
        .success;
    expect(slack('https://hooks.slack.com/services/T0/B0/abc')).toBe(true);
    expect(slack('http://hooks.slack.com/services/T0/B0/abc')).toBe(false);
    expect(slack('https://hooks.slack.com.evil.com/x')).toBe(false);
    expect(slack('https://example.com/services/x')).toBe(false);
  });

  it('accepts Discord channel webhook URLs only', () => {
    const discord = (webhookUrl: string) =>
      createDestinationSchema.safeParse({ type: 'DISCORD', name: 'd', config: { webhookUrl } })
        .success;
    expect(discord('https://discord.com/api/webhooks/123/abc')).toBe(true);
    expect(discord('https://discordapp.com/api/webhooks/123/abc')).toBe(true);
    expect(discord('https://discord.com/channels/123')).toBe(false);
    expect(discord('http://discord.com/api/webhooks/123/abc')).toBe(false);
    expect(discord('https://discord.com.evil.io/api/webhooks/1/a')).toBe(false);
  });

  it('accepts Teams incoming webhook and Workflows URLs', () => {
    const teams = (webhookUrl: string) =>
      createDestinationSchema.safeParse({ type: 'TEAMS', name: 't', config: { webhookUrl } })
        .success;
    expect(teams('https://contoso.webhook.office.com/webhookb2/abc')).toBe(true);
    expect(teams('https://prod-12.westus.logic.azure.com:443/workflows/abc/triggers')).toBe(true);
    expect(teams('https://default1.environment.api.powerplatform.com/powerautomate/x')).toBe(true);
    expect(teams('https://webhook.office.com.evil.io/x')).toBe(false);
    expect(teams('https://evilwebhook.office.com/x')).toBe(false);
    expect(teams('http://contoso.webhook.office.com/x')).toBe(false);
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
