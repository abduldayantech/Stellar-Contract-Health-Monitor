import { describe, expect, it } from 'vitest';
import { pagerDutyDedupKey, pagerDutyEvent } from '../../src/pagerduty';
import { samplePayload } from './fixtures';

const KEY = 'a'.repeat(32);

describe('pagerDutyEvent', () => {
  it('maps a triggered alert onto an Events API v2 trigger', () => {
    const event = pagerDutyEvent(
      samplePayload({
        alert: { ...samplePayload().alert, context: { matched: 3 } },
      }),
      KEY,
      'https://dash.example.com/',
    );
    expect(event).toEqual({
      routing_key: KEY,
      event_action: 'trigger',
      dedup_key: 'schm-alert-alert_1',
      payload: {
        summary: 'Large <transfer> & mint',
        source: 'testnet:CABC',
        severity: 'critical',
        timestamp: '2026-10-26T11:59:00.000Z',
        component: 'Token',
        group: 'Large transfers',
        class: 'EVENT_MATCH',
        custom_details: {
          message: 'Amount > 1000',
          contract: { id: 'c1', contractId: 'CABC', network: 'TESTNET', label: 'Token' },
          rule: { id: 'r1', name: 'Large transfers', type: 'EVENT_MATCH' },
          context: { matched: 3 },
        },
      },
      links: [
        {
          href: 'https://dash.example.com/alerts/history?alert=alert_1',
          text: 'Open in Stellar Contract Health Monitor',
        },
      ],
      client: 'Stellar Contract Health Monitor',
      client_url: 'https://dash.example.com',
    });
  });

  it('maps every severity', () => {
    const severity = (s: 'INFO' | 'WARNING' | 'CRITICAL') =>
      pagerDutyEvent(
        samplePayload({ alert: { ...samplePayload().alert, severity: s } }),
        KEY,
        'https://d',
      ).payload?.severity;
    expect([severity('INFO'), severity('WARNING'), severity('CRITICAL')]).toEqual([
      'info',
      'warning',
      'critical',
    ]);
  });

  it('resolves with the same dedup key and nothing else', () => {
    const triggered = pagerDutyEvent(samplePayload(), KEY, 'https://d');
    const resolved = pagerDutyEvent(samplePayload({ type: 'alert.resolved' }), KEY, 'https://d');
    expect(resolved).toEqual({
      routing_key: KEY,
      event_action: 'resolve',
      dedup_key: triggered.dedup_key,
    });
    expect(pagerDutyDedupKey('alert_1')).toBe(triggered.dedup_key);
  });

  it('describes system alerts without a contract or rule', () => {
    const event = pagerDutyEvent(
      samplePayload({ alert: { ...samplePayload().alert, contract: null, rule: null } }),
      KEY,
      'https://d',
    );
    expect(event.payload).toMatchObject({ source: 'stellar-contract-health-monitor' });
    expect(event.payload).not.toHaveProperty('component');
    expect(event.payload).not.toHaveProperty('group');
  });
});
