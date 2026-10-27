import { describe, expect, it } from 'vitest';
import {
  chatMessage,
  DISCORD_COLORS,
  discordMessage,
  escapeSlack,
  slackMessage,
} from '../../src/chat';
import { deliveryBackoff, retryAfterMs } from '../../src/delivery';
import { samplePayload } from './fixtures';

describe('chatMessage', () => {
  it('resolves display fields and the dashboard link', () => {
    const m = chatMessage(samplePayload(), 'https://dash.example.com/');
    expect(m).toMatchObject({
      prefix: '[CRITICAL]',
      contract: 'Token · CABC (TESTNET)',
      link: 'https://dash.example.com/alerts/history?alert=alert_1',
      resolved: false,
    });
  });

  it('marks resolved alerts and omits the link for tests', () => {
    expect(chatMessage(samplePayload({ type: 'alert.resolved' }), 'http://x').prefix).toBe(
      '[RESOLVED]',
    );
    const test = samplePayload({ type: 'test' });
    test.alert = { ...test.alert, id: 'test', contract: null };
    expect(chatMessage(test, 'http://x')).toMatchObject({ link: null, contract: null });
  });
});

describe('slackMessage', () => {
  it('escapes mrkdwn control characters and adds a dashboard button', () => {
    expect(escapeSlack('a <b> & c')).toBe('a &lt;b&gt; &amp; c');
    const msg = slackMessage(chatMessage(samplePayload(), 'https://dash.example.com'));
    expect(msg.text).toBe('[CRITICAL] Large &lt;transfer&gt; &amp; mint');
    expect(msg.blocks[0]).toMatchObject({ type: 'header' });
    expect(msg.blocks[1]).toMatchObject({ text: { text: 'Amount &gt; 1000' } });
    expect(msg.blocks.at(-1)).toMatchObject({
      type: 'actions',
      elements: [{ url: 'https://dash.example.com/alerts/history?alert=alert_1' }],
    });
  });
});

describe('discordMessage', () => {
  it('colours the embed by severity and disables mentions', () => {
    const msg = discordMessage(chatMessage(samplePayload(), 'https://dash.example.com'));
    expect(msg.allowed_mentions).toEqual({ parse: [] });
    expect(msg.embeds[0]).toMatchObject({
      title: '[CRITICAL] Large <transfer> & mint',
      color: DISCORD_COLORS.CRITICAL,
      url: 'https://dash.example.com/alerts/history?alert=alert_1',
      fields: [
        { name: 'Severity', value: 'CRITICAL' },
        { name: 'Contract', value: 'Token · CABC (TESTNET)' },
      ],
    });
    const resolved = discordMessage(chatMessage(samplePayload({ type: 'alert.resolved' }), 'x'));
    expect(resolved.embeds[0]!.color).toBe(DISCORD_COLORS.RESOLVED);
  });
});

describe('retry timing', () => {
  it('reads Retry-After headers and Discord retry_after bodies', () => {
    expect(retryAfterMs('3', '')).toBe(3000);
    expect(retryAfterMs(null, '{"retry_after": 1.25, "global": false}')).toBe(1250);
    expect(retryAfterMs(null, 'not json')).toBeUndefined();
  });

  it('backs off exponentially but never sooner than Retry-After', () => {
    expect(deliveryBackoff(1)).toBe(10_000);
    expect(deliveryBackoff(3)).toBe(40_000);
    expect(
      deliveryBackoff(1, 'delivery', Object.assign(new Error(), { retryAfterMs: 90_000 })),
    ).toBe(90_000);
    expect(deliveryBackoff(20)).toBe(3600_000);
  });
});
