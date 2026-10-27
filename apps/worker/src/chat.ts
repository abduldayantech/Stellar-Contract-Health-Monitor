import type { WebhookPayload } from '@stellar-health/shared-types';

/** The parts of an alert every chat message shows, already resolved to display strings. */
export interface ChatMessage {
  /** "[CRITICAL]" or "[RESOLVED]" */
  prefix: string;
  title: string;
  message: string;
  severity: WebhookPayload['alert']['severity'];
  resolved: boolean;
  contract: string | null;
  triggeredAt: string;
  /** Dashboard link for the alert; null for test notifications. */
  link: string | null;
}

export function chatMessage(payload: WebhookPayload, dashboardUrl: string): ChatMessage {
  const a = payload.alert;
  const resolved = payload.type === 'alert.resolved';
  return {
    prefix: resolved ? '[RESOLVED]' : `[${a.severity}]`,
    title: a.title,
    message: a.message,
    severity: a.severity,
    resolved,
    contract: a.contract
      ? `${a.contract.label ? `${a.contract.label} · ` : ''}${a.contract.contractId} (${a.contract.network})`
      : null,
    triggeredAt: a.triggeredAt,
    link:
      a.id !== 'test'
        ? `${dashboardUrl.replace(/\/$/, '')}/alerts/history?alert=${encodeURIComponent(a.id)}`
        : null,
  };
}

/** Slack mrkdwn treats &, < and > as control characters. */
export function escapeSlack(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Block Kit message for a Slack incoming webhook. */
export function slackMessage(m: ChatMessage) {
  const fields = [
    `*Severity:* ${m.resolved ? 'Resolved' : m.severity}`,
    ...(m.contract ? [`*Contract:* ${escapeSlack(m.contract)}`] : []),
    `*Triggered:* ${m.triggeredAt}`,
  ];
  return {
    // Fallback for notifications and clients that cannot render blocks.
    text: escapeSlack(`${m.prefix} ${m.title}`),
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: `${m.prefix} ${m.title}`.slice(0, 150) },
      },
      { type: 'section', text: { type: 'mrkdwn', text: escapeSlack(m.message).slice(0, 3000) } },
      { type: 'context', elements: fields.map((text) => ({ type: 'mrkdwn', text })) },
      ...(m.link
        ? [
            {
              type: 'actions',
              elements: [
                {
                  type: 'button',
                  text: { type: 'plain_text', text: 'View in dashboard' },
                  url: m.link,
                },
              ],
            },
          ]
        : []),
    ],
  };
}
