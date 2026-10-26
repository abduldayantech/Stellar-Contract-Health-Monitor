import { signWebhook } from '@stellar-health/alert-engine';
import {
  WEBHOOK_DELIVERY_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  discordConfigSchema,
  emailConfigSchema,
  slackConfigSchema,
  teamsConfigSchema,
  webhookConfigSchema,
  type WebhookPayload,
} from '@stellar-health/shared-types';
import { openDestinationConfig } from '@stellar-health/db';
import { chatMessage, discordMessage, slackMessage, teamsMessage } from './chat';
import type { WorkerDeps } from './deps';
import { recordDestinationFailure, recordDestinationSuccess } from './destination-health';
import { assertPublicUrl } from './ssrf';

/** Delivery failed in a way retries cannot fix (bad config, 4xx response, disabled destination). */
export class PermanentDeliveryError extends Error {}

export interface Mailer {
  send(opts: { to: string[]; subject: string; text: string }): Promise<void>;
}

export interface DeliveryDeps extends WorkerDeps {
  mailer: Mailer | null;
  fetchImpl?: typeof fetch;
}

export async function buildPayload(deps: WorkerDeps, deliveryId: string): Promise<WebhookPayload> {
  const delivery = await deps.prisma.notificationDelivery.findUniqueOrThrow({
    where: { id: deliveryId },
    include: {
      alert: {
        include: {
          rule: { select: { id: true, name: true, type: true } },
          contract: { select: { id: true, contractId: true, network: true, label: true } },
        },
      },
    },
  });
  const sentAt = deps.now().toISOString();
  if (delivery.kind === 'test' || !delivery.alert) {
    return {
      version: 1,
      deliveryId,
      type: 'test',
      sentAt,
      alert: {
        id: 'test',
        title: 'Test notification from Stellar Contract Health Monitor',
        message: 'If you can read this, your destination is configured correctly.',
        severity: 'INFO',
        status: 'TRIGGERED',
        triggeredAt: sentAt,
        rule: null,
        contract: null,
        context: {},
      },
    };
  }
  const a = delivery.alert;
  return {
    version: 1,
    deliveryId,
    type: delivery.kind === 'alert.resolved' ? 'alert.resolved' : 'alert.triggered',
    sentAt,
    alert: {
      id: a.id,
      title: a.title,
      message: a.message,
      severity: a.severity,
      status: a.status,
      triggeredAt: a.triggeredAt.toISOString(),
      rule: a.rule,
      contract: a.contract,
      context: (a.context ?? {}) as Record<string, unknown>,
    },
  };
}

function openConfig(deps: DeliveryDeps, config: unknown): Record<string, unknown> {
  try {
    return openDestinationConfig(deps.secrets, config);
  } catch (err) {
    throw new PermanentDeliveryError(`Cannot read webhook secret: ${(err as Error).message}`);
  }
}

/**
 * POSTs JSON and classifies the response: 2xx returns the status, 408/429/5xx throw a
 * retryable error, anything else (other 4xx, redirects) throws a PermanentDeliveryError.
 */
async function postJson(
  deps: DeliveryDeps,
  url: string,
  body: string,
  headers: Record<string, string> = {},
): Promise<number> {
  const res = await (deps.fetchImpl ?? fetch)(url, {
    method: 'POST',
    redirect: 'manual',
    signal: AbortSignal.timeout(deps.config.WEBHOOK_TIMEOUT_MS),
    headers: {
      ...headers,
      'content-type': 'application/json',
      'user-agent': 'stellar-contract-health-monitor/1.0',
    },
    body,
  });
  if (res.ok) return res.status;
  const text = (await res.text().catch(() => '')).slice(0, 300);
  const msg = `Destination responded ${res.status}${text ? `: ${text}` : ''}`;
  // 408/429 and 5xx are worth retrying; other 4xx (and redirects) won't fix themselves.
  if (res.status === 408 || res.status === 429 || res.status >= 500) {
    throw Object.assign(new Error(msg), {
      responseStatus: res.status,
      retryAfterMs: retryAfterMs(res.headers.get('retry-after'), text),
    });
  }
  throw Object.assign(new PermanentDeliveryError(msg), { responseStatus: res.status });
}

/**
 * How long the destination asked us to wait, from a `Retry-After` header (seconds) or a
 * Discord-style JSON body (`{"retry_after": 1.5}`, seconds).
 */
export function retryAfterMs(header: string | null, body: string): number | undefined {
  const seconds = Number(header);
  if (header && Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  try {
    const parsed = JSON.parse(body) as { retry_after?: unknown };
    if (typeof parsed.retry_after === 'number' && parsed.retry_after >= 0)
      return Math.ceil(parsed.retry_after * 1000);
  } catch {
    // Not JSON; no hint.
  }
  return undefined;
}

const MAX_BACKOFF_MS = 3600_000;

/**
 * BullMQ backoff for notification jobs (`DELIVERY_BACKOFF`): 10s, 20s, 40s… capped at an hour,
 * but never sooner than the destination's Retry-After.
 */
export function deliveryBackoff(attemptsMade: number, _type?: string, err?: Error): number {
  const exponential = 10_000 * 2 ** Math.max(0, attemptsMade - 1);
  const hint = (err as { retryAfterMs?: number } | undefined)?.retryAfterMs ?? 0;
  return Math.min(Math.max(exponential, hint), MAX_BACKOFF_MS);
}

async function sendWebhook(deps: DeliveryDeps, config: unknown, payload: WebhookPayload) {
  const parsed = webhookConfigSchema.safeParse(openConfig(deps, config));
  if (!parsed.success || !parsed.data.secret)
    throw new PermanentDeliveryError('Invalid webhook configuration');
  const { url, secret, headers } = parsed.data;
  if (deps.config.WEBHOOK_BLOCK_PRIVATE_IPS) {
    try {
      await assertPublicUrl(url);
    } catch (err) {
      throw new PermanentDeliveryError((err as Error).message);
    }
  }
  const body = JSON.stringify(payload);
  const timestamp = Math.floor(deps.now().getTime() / 1000);
  return postJson(deps, url, body, {
    ...headers,
    [WEBHOOK_SIGNATURE_HEADER]: signWebhook(secret, timestamp, body),
    [WEBHOOK_TIMESTAMP_HEADER]: String(timestamp),
    [WEBHOOK_DELIVERY_HEADER]: payload.deliveryId,
  });
}

async function sendSlack(deps: DeliveryDeps, config: unknown, payload: WebhookPayload) {
  const parsed = slackConfigSchema.safeParse(openConfig(deps, config));
  if (!parsed.success) throw new PermanentDeliveryError('Invalid Slack configuration');
  const message = slackMessage(chatMessage(payload, deps.config.PUBLIC_DASHBOARD_URL));
  return postJson(deps, parsed.data.webhookUrl, JSON.stringify(message));
}

async function sendDiscord(deps: DeliveryDeps, config: unknown, payload: WebhookPayload) {
  const parsed = discordConfigSchema.safeParse(openConfig(deps, config));
  if (!parsed.success) throw new PermanentDeliveryError('Invalid Discord configuration');
  const message = discordMessage(chatMessage(payload, deps.config.PUBLIC_DASHBOARD_URL));
  return postJson(deps, parsed.data.webhookUrl, JSON.stringify(message));
}

async function sendTeams(deps: DeliveryDeps, config: unknown, payload: WebhookPayload) {
  const parsed = teamsConfigSchema.safeParse(openConfig(deps, config));
  if (!parsed.success) throw new PermanentDeliveryError('Invalid Teams configuration');
  const message = teamsMessage(chatMessage(payload, deps.config.PUBLIC_DASHBOARD_URL));
  return postJson(deps, parsed.data.webhookUrl, JSON.stringify(message));
}

async function sendEmail(deps: DeliveryDeps, config: unknown, payload: WebhookPayload) {
  if (!deps.mailer)
    throw new PermanentDeliveryError('Email is not configured on this server (SMTP_HOST is empty)');
  const parsed = emailConfigSchema.safeParse(config);
  if (!parsed.success) throw new PermanentDeliveryError('Invalid email configuration');
  const a = payload.alert;
  const prefix = payload.type === 'alert.resolved' ? '[RESOLVED]' : `[${a.severity}]`;
  const link =
    a.id !== 'test'
      ? `${deps.config.PUBLIC_DASHBOARD_URL.replace(/\/$/, '')}/alerts/history?alert=${a.id}`
      : '';
  const contractLine = a.contract
    ? `Contract: ${a.contract.label ?? ''} ${a.contract.contractId} (${a.contract.network})\n`
    : '';
  await deps.mailer.send({
    to: parsed.data.to,
    subject: `${prefix} ${a.title}`.slice(0, 200),
    text: `${a.title}\n\n${a.message}\n\n${contractLine}Triggered: ${a.triggeredAt}\n${link ? `\nView in dashboard: ${link}\n` : ''}`,
  });
}

/**
 * Attempts one delivery. Throws on failure so the queue retries with backoff;
 * `isFinalAttempt` lets us mark the delivery FAILED when no retries remain.
 */
export async function deliverNotification(
  deps: DeliveryDeps,
  deliveryId: string,
  attempt: { number: number; isFinalAttempt: boolean },
): Promise<'sent' | 'skipped'> {
  const delivery = await deps.prisma.notificationDelivery.findUnique({
    where: { id: deliveryId },
    include: { destination: true },
  });
  if (!delivery || delivery.status === 'SUCCEEDED') return 'skipped';
  const type = delivery.destination.type;
  const started = Date.now();
  let responseStatus: number | null = null;

  try {
    if (!delivery.destination.enabled) throw new PermanentDeliveryError('Destination is disabled');
    const payload = await buildPayload(deps, deliveryId);
    const config = delivery.destination.config;
    switch (type) {
      case 'WEBHOOK':
        responseStatus = await sendWebhook(deps, config, payload);
        break;
      case 'EMAIL':
        await sendEmail(deps, config, payload);
        break;
      case 'SLACK':
        responseStatus = await sendSlack(deps, config, payload);
        break;
      case 'DISCORD':
        responseStatus = await sendDiscord(deps, config, payload);
        break;
      case 'TEAMS':
        responseStatus = await sendTeams(deps, config, payload);
        break;
    }

    await deps.prisma.notificationDelivery.update({
      where: { id: deliveryId },
      data: {
        status: 'SUCCEEDED',
        attempts: attempt.number,
        responseStatus,
        lastError: null,
        lastAttemptAt: deps.now(),
        deliveredAt: deps.now(),
      },
    });
    deps.metrics.deliveries.labels(type, 'success').inc();
    await recordDestinationSuccess(deps, delivery.destinationId);
    return 'sent';
  } catch (err) {
    const permanent = err instanceof PermanentDeliveryError;
    const final = permanent || attempt.isFinalAttempt;
    const message =
      (err as Error).name === 'TimeoutError'
        ? `Timed out after ${deps.config.WEBHOOK_TIMEOUT_MS}ms`
        : (err as Error).message;
    await deps.prisma.notificationDelivery.update({
      where: { id: deliveryId },
      data: {
        status: final ? 'FAILED' : 'PENDING',
        attempts: attempt.number,
        responseStatus: (err as { responseStatus?: number }).responseStatus ?? null,
        lastError: message.slice(0, 1000),
        lastAttemptAt: deps.now(),
      },
    });
    deps.metrics.deliveries.labels(type, final ? 'failed' : 'retry').inc();
    if (final && delivery.kind !== 'test') {
      await recordDestinationFailure(deps, delivery.destinationId, message.slice(0, 300)).catch(
        (e: unknown) => deps.logger.error({ err: e, deliveryId }, 'failed to record failure'),
      );
    }
    deps.logger.warn(
      { deliveryId, attempt: attempt.number, final, err: message },
      'notification delivery failed',
    );
    throw err;
  } finally {
    deps.metrics.deliveryDuration.labels(type).observe((Date.now() - started) / 1000);
  }
}
