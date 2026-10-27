import type { WebhookPayload } from '@stellar-health/shared-types';

/** A triggered CRITICAL alert payload with characters that chat formats must escape. */
export function samplePayload(overrides: Partial<WebhookPayload> = {}): WebhookPayload {
  return {
    version: 1,
    deliveryId: 'd1',
    type: 'alert.triggered',
    sentAt: '2026-10-26T12:00:00.000Z',
    alert: {
      id: 'alert_1',
      title: 'Large <transfer> & mint',
      message: 'Amount > 1000',
      severity: 'CRITICAL',
      status: 'TRIGGERED',
      triggeredAt: '2026-10-26T11:59:00.000Z',
      rule: { id: 'r1', name: 'Large transfers', type: 'EVENT_MATCH' },
      contract: { id: 'c1', contractId: 'CABC', network: 'TESTNET', label: 'Token' },
      context: {},
    },
    ...overrides,
  };
}
