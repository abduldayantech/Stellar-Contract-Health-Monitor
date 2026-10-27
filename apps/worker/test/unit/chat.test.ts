import { describe, expect, it } from 'vitest';
import { chatMessage, escapeSlack, slackMessage } from '../../src/chat';
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
