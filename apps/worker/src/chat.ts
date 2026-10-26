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

/** Embed colours by severity; resolved alerts are green. */
export const DISCORD_COLORS = {
  INFO: 0x3b82f6,
  WARNING: 0xf59e0b,
  CRITICAL: 0xef4444,
  RESOLVED: 0x22c55e,
} as const;

/** Webhook body with one embed for a Discord channel webhook. */
export function discordMessage(m: ChatMessage) {
  return {
    username: 'Stellar Contract Health',
    // Alert text comes from contract data; never let it ping @everyone, roles or users.
    allowed_mentions: { parse: [] as string[] },
    embeds: [
      {
        title: `${m.prefix} ${m.title}`.slice(0, 256),
        description: m.message.slice(0, 4096),
        color: m.resolved ? DISCORD_COLORS.RESOLVED : DISCORD_COLORS[m.severity],
        ...(m.link ? { url: m.link } : {}),
        fields: [
          { name: 'Severity', value: m.resolved ? 'Resolved' : m.severity, inline: true },
          ...(m.contract ? [{ name: 'Contract', value: m.contract.slice(0, 1024) }] : []),
        ],
        timestamp: m.triggeredAt,
      },
    ],
  };
}

/** Adaptive Card text colours by severity. */
const TEAMS_COLORS = { INFO: 'Accent', WARNING: 'Warning', CRITICAL: 'Attention' } as const;

/** Teams message with one Adaptive Card, accepted by incoming webhooks and Workflows. */
export function teamsMessage(m: ChatMessage) {
  return {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        contentUrl: null,
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.4',
          msteams: { width: 'Full' },
          body: [
            {
              type: 'TextBlock',
              text: `${m.prefix} ${m.title}`,
              weight: 'Bolder',
              size: 'Medium',
              wrap: true,
              color: m.resolved ? 'Good' : TEAMS_COLORS[m.severity],
            },
            { type: 'TextBlock', text: m.message, wrap: true },
            {
              type: 'FactSet',
              facts: [
                { title: 'Severity', value: m.resolved ? 'Resolved' : m.severity },
                ...(m.contract ? [{ title: 'Contract', value: m.contract }] : []),
                { title: 'Triggered', value: m.triggeredAt },
              ],
            },
          ],
          actions: m.link
            ? [{ type: 'Action.OpenUrl', title: 'View in dashboard', url: m.link }]
            : [],
        },
      },
    ],
  };
}

/** Telegram's HTML parse mode needs &, < and > escaped in text. */
export function escapeTelegram(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** `sendMessage` body using HTML parse mode (max 4096 characters). */
export function telegramMessage(m: ChatMessage, chatId: string) {
  const lines = [
    `<b>${escapeTelegram(`${m.prefix} ${m.title}`)}</b>`,
    '',
    escapeTelegram(m.message),
    '',
    `<b>Severity:</b> ${m.resolved ? 'Resolved' : m.severity}`,
    ...(m.contract ? [`<b>Contract:</b> <code>${escapeTelegram(m.contract)}</code>`] : []),
    `<b>Triggered:</b> ${escapeTelegram(m.triggeredAt)}`,
    ...(m.link ? ['', `<a href="${escapeTelegram(m.link)}">View in dashboard</a>`] : []),
  ];
  let text = lines.join('\n');
  if (text.length > 4096) {
    // Trim the message body rather than cutting through an HTML tag.
    const over = text.length - 4096 + 1;
    const body = escapeTelegram(m.message);
    lines[2] = `${body.slice(0, Math.max(0, body.length - over)).replace(/&[a-z]*$/, '')}…`;
    text = lines.join('\n');
  }
  return {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  };
}
