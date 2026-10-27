import type { AlertSeverity, WebhookPayload } from '@stellar-health/shared-types';

/** Events API v2 endpoints; EU accounts have their own. */
export const PAGERDUTY_EVENTS_URL = {
  us: 'https://events.pagerduty.com/v2/enqueue',
  eu: 'https://events.eu.pagerduty.com/v2/enqueue',
} as const;

const SEVERITY: Record<AlertSeverity, 'info' | 'warning' | 'critical'> = {
  INFO: 'info',
  WARNING: 'warning',
  CRITICAL: 'critical',
};

export interface PagerDutyEvent {
  routing_key: string;
  event_action: 'trigger' | 'resolve';
  dedup_key: string;
  payload?: {
    summary: string;
    source: string;
    severity: 'info' | 'warning' | 'critical';
    timestamp: string;
    component?: string;
    group?: string;
    class?: string;
    custom_details: Record<string, unknown>;
  };
  links?: { href: string; text: string }[];
  client?: string;
  client_url?: string;
}

/**
 * The incident key for an alert. The trigger and the later resolve use the same key, so
 * PagerDuty closes the incident it opened (and groups repeat triggers into it).
 */
export const pagerDutyDedupKey = (alertId: string) => `schm-alert-${alertId}`;

/** Maps a notification payload onto a PagerDuty Events API v2 event. */
export function pagerDutyEvent(
  payload: WebhookPayload,
  routingKey: string,
  dashboardUrl: string,
  dedupKey = pagerDutyDedupKey(payload.alert.id),
): PagerDutyEvent {
  if (payload.type === 'alert.resolved') {
    return { routing_key: routingKey, event_action: 'resolve', dedup_key: dedupKey };
  }
  const a = payload.alert;
  const base = dashboardUrl.replace(/\/$/, '');
  const link = a.id === 'test' ? base : `${base}/alerts/history?alert=${encodeURIComponent(a.id)}`;
  return {
    routing_key: routingKey,
    event_action: 'trigger',
    dedup_key: dedupKey,
    payload: {
      // PagerDuty truncates longer summaries; keep the whole title.
      summary: a.title.slice(0, 1024),
      source: a.contract
        ? `${a.contract.network.toLowerCase()}:${a.contract.contractId}`
        : 'stellar-contract-health-monitor',
      severity: SEVERITY[a.severity] ?? 'warning',
      timestamp: a.triggeredAt,
      ...(a.contract?.label ? { component: a.contract.label } : {}),
      ...(a.rule ? { group: a.rule.name, class: a.rule.type } : {}),
      custom_details: {
        message: a.message,
        ...(a.contract ? { contract: a.contract } : {}),
        ...(a.rule ? { rule: a.rule } : {}),
        ...(Object.keys(a.context).length > 0 ? { context: a.context } : {}),
      },
    },
    links: [{ href: link, text: 'Open in Stellar Contract Health Monitor' }],
    client: 'Stellar Contract Health Monitor',
    client_url: base,
  };
}
