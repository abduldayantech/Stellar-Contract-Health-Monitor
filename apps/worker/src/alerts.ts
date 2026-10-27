import type { AlertRule, AlertSeverity, Contract, Prisma } from '@stellar-health/db';
import type { AlertDescription } from '@stellar-health/alert-engine';
import { notificationPreferencesSchema } from '@stellar-health/shared-types';
import type { WorkerDeps } from './deps';

const PREFERENCES_KEY = 'notificationPreferences';

function dateParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  return {
    year: value('year'),
    month: value('month'),
    day: value('day'),
    hour: value('hour'),
    minute: value('minute'),
    second: value('second'),
  };
}

function localDateTimeToUtc(
  parts: ReturnType<typeof dateParts>,
  milliseconds: number,
  timeZone: string,
): Date {
  const localTimestamp =
    Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) +
    milliseconds;
  const offsets = [-36, 0, 36].map((hours) => {
    const probe = localTimestamp + hours * 3_600_000;
    const local = dateParts(new Date(probe), timeZone);
    return (
      Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second) -
      (probe - (probe % 1000))
    );
  });
  const candidates = [...new Set(offsets)].map((offset) => new Date(localTimestamp - offset));
  const exact = candidates.filter((candidate) => {
    const local = dateParts(candidate, timeZone);
    return (
      local.year === parts.year &&
      local.month === parts.month &&
      local.day === parts.day &&
      local.hour === parts.hour &&
      local.minute === parts.minute &&
      local.second === parts.second
    );
  });
  if (exact.length) return new Date(Math.min(...exact.map((candidate) => candidate.getTime())));
  return (
    candidates
      .map((candidate) => {
        const local = dateParts(candidate, timeZone);
        return {
          candidate,
          delta:
            Date.UTC(
              local.year,
              local.month - 1,
              local.day,
              local.hour,
              local.minute,
              local.second,
            ) - localTimestamp,
        };
      })
      .filter(({ delta }) => delta >= 0)
      .sort((a, b) => a.delta - b.delta)[0]?.candidate ?? candidates[0]!
  );
}

function activeNow(
  silence: {
    startsAt: Date;
    endsAt: Date;
    recurrence: 'DAILY' | 'WEEKLY' | null;
    timeZone: string;
  },
  now: Date,
): boolean {
  if (!silence.recurrence) return silence.startsAt <= now && now < silence.endsAt;

  const anchor = dateParts(silence.startsAt, silence.timeZone);
  const current = dateParts(now, silence.timeZone);
  const currentDay = Date.UTC(current.year, current.month - 1, current.day);
  const anchorDay = Date.UTC(anchor.year, anchor.month - 1, anchor.day);
  let daysBack =
    silence.recurrence === 'DAILY'
      ? 0
      : (new Date(currentDay).getUTCDay() - new Date(anchorDay).getUTCDay() + 7) % 7;
  const startParts = new Date(currentDay - daysBack * 86_400_000);
  let occurrenceStart = localDateTimeToUtc(
    {
      ...current,
      year: startParts.getUTCFullYear(),
      month: startParts.getUTCMonth() + 1,
      day: startParts.getUTCDate(),
      hour: anchor.hour,
      minute: anchor.minute,
      second: anchor.second,
    },
    silence.startsAt.getUTCMilliseconds(),
    silence.timeZone,
  );
  const intervalDays = silence.recurrence === 'DAILY' ? 1 : 7;
  if (occurrenceStart > now) {
    daysBack += intervalDays;
    const previousStart = new Date(currentDay - daysBack * 86_400_000);
    occurrenceStart = localDateTimeToUtc(
      {
        ...current,
        year: previousStart.getUTCFullYear(),
        month: previousStart.getUTCMonth() + 1,
        day: previousStart.getUTCDate(),
        hour: anchor.hour,
        minute: anchor.minute,
        second: anchor.second,
      },
      silence.startsAt.getUTCMilliseconds(),
      silence.timeZone,
    );
  }
  const occurrenceEnd = new Date(
    occurrenceStart.getTime() + silence.endsAt.getTime() - silence.startsAt.getTime(),
  );
  return occurrenceStart <= now && now < occurrenceEnd;
}

async function loadPreferences(deps: WorkerDeps) {
  const row = await deps.prisma.setting.findUnique({ where: { key: PREFERENCES_KEY } });
  return notificationPreferencesSchema.parse(row?.value ?? {});
}

/** Destinations for a rule: its own enabled destinations, else the global defaults. */
async function destinationsFor(deps: WorkerDeps, ruleId: string): Promise<string[]> {
  const rule = await deps.prisma.alertRule.findUnique({
    where: { id: ruleId },
    select: { destinations: { where: { enabled: true }, select: { id: true } } },
  });
  const own = rule?.destinations.map((d) => d.id) ?? [];
  if (own.length > 0) return own;
  const prefs = await loadPreferences(deps);
  if (prefs.defaultDestinationIds.length === 0) return [];
  const enabled = await deps.prisma.notificationDestination.findMany({
    where: { id: { in: prefs.defaultDestinationIds }, enabled: true },
    select: { id: true },
  });
  return enabled.map((d) => d.id);
}

/**
 * Persists an alert, records rule state and queues a delivery per destination.
 * `level` marks condition-based alerts (TTL, inactivity) which stay open until resolved.
 */
export async function triggerAlert(
  deps: WorkerDeps,
  params: {
    rule: Pick<AlertRule, 'id' | 'type' | 'name'>;
    contract: Pick<Contract, 'id'>;
    severity: AlertSeverity;
    description: AlertDescription;
    level: boolean;
  },
): Promise<string> {
  const { rule, contract, description } = params;
  const now = deps.now();
  const destinationIds = await destinationsFor(deps, rule.id);
  const maxAttempts = deps.config.WEBHOOK_MAX_ATTEMPTS;

  const { alertId, deliveryIds, silenced } = await deps.prisma.$transaction(async (tx) => {
    const silences = await tx.silence.findMany({
      where: {
        AND: [
          { OR: [{ contractRefId: contract.id }, { contractRefId: null }] },
          { OR: [{ ruleId: rule.id }, { ruleId: null }] },
          { startsAt: { lte: now } },
          { OR: [{ recurrence: null, endsAt: { gt: now } }, { recurrence: { not: null } }] },
        ],
      },
    });
    const silenced = silences.some((silence) => activeNow(silence, now));
    const alert = await tx.alert.create({
      data: {
        ruleId: rule.id,
        contractRefId: contract.id,
        severity: params.severity,
        title: description.title.slice(0, 500),
        message: description.message.slice(0, 5000),
        context: description.context as Prisma.InputJsonValue,
        silenced,
        triggeredAt: now,
        deliveries: {
          create: (silenced ? [] : destinationIds).map((destinationId) => ({
            destinationId,
            kind: 'alert.triggered',
            maxAttempts,
          })),
        },
      },
      include: { deliveries: { select: { id: true } } },
    });
    await tx.alertRuleState.upsert({
      where: { ruleId_contractRefId: { ruleId: rule.id, contractRefId: contract.id } },
      create: {
        ruleId: rule.id,
        contractRefId: contract.id,
        lastTriggeredAt: now,
        openAlertId: params.level ? alert.id : null,
      },
      update: { lastTriggeredAt: now, ...(params.level ? { openAlertId: alert.id } : {}) },
    });
    return {
      alertId: alert.id,
      deliveryIds: alert.deliveries.map((d) => d.id),
      silenced,
    };
  });

  deps.metrics.alertsTriggered.labels(rule.type, params.severity).inc();
  deps.logger.info(
    {
      alertId,
      ruleId: rule.id,
      contractRefId: contract.id,
      silenced,
      deliveries: deliveryIds.length,
    },
    'alert triggered',
  );
  for (const id of deliveryIds) await deps.enqueueDelivery(id);
  return alertId;
}

/** Enabled incident-tool destinations (PagerDuty) that were sent this alert's trigger. */
export async function incidentDestinationsFor(deps: WorkerDeps, alertId: string) {
  const rows = await deps.prisma.notificationDelivery.findMany({
    where: {
      alertId,
      kind: 'alert.triggered',
      destination: { type: 'PAGERDUTY', enabled: true },
    },
    select: { destinationId: true },
    distinct: ['destinationId'],
  });
  return rows.map((r) => r.destinationId);
}

/** Resolves a level alert whose condition cleared, optionally notifying destinations. */
export async function resolveLevelAlert(
  deps: WorkerDeps,
  params: { rule: Pick<AlertRule, 'id' | 'type'>; contractRefId: string; alertId: string },
): Promise<void> {
  const now = deps.now();
  const alert = await deps.prisma.alert.findUnique({ where: { id: params.alertId } });
  await deps.prisma.alertRuleState.update({
    where: {
      ruleId_contractRefId: { ruleId: params.rule.id, contractRefId: params.contractRefId },
    },
    data: { openAlertId: null },
  });
  if (!alert || alert.status === 'RESOLVED') return;
  await deps.prisma.alert.update({
    where: { id: alert.id },
    data: { status: 'RESOLVED', resolvedAt: now },
  });
  deps.metrics.alertsResolved.labels(params.rule.type).inc();
  if (alert.silenced) return;

  // Incident tools such as PagerDuty must hear about the resolve to close what they opened,
  // whatever the resolve-notification preference says.
  const destinationIds = new Set(await incidentDestinationsFor(deps, alert.id));
  const prefs = await loadPreferences(deps);
  if (prefs.notifyOnResolve) {
    for (const id of await destinationsFor(deps, params.rule.id)) destinationIds.add(id);
  }
  for (const destinationId of destinationIds) {
    const d = await deps.prisma.notificationDelivery.create({
      data: {
        alertId: alert.id,
        destinationId,
        kind: 'alert.resolved',
        maxAttempts: deps.config.WEBHOOK_MAX_ATTEMPTS,
      },
    });
    await deps.enqueueDelivery(d.id);
  }
}

/** Returns the open alert id for a level rule, ignoring alerts a user already resolved. */
export async function openAlertFor(deps: WorkerDeps, ruleId: string, contractRefId: string) {
  const state = await deps.prisma.alertRuleState.findUnique({
    where: { ruleId_contractRefId: { ruleId, contractRefId } },
  });
  if (!state) return { state: null, openAlertId: null as string | null };
  if (!state.openAlertId) return { state, openAlertId: null };
  const alert = await deps.prisma.alert.findUnique({
    where: { id: state.openAlertId },
    select: { status: true },
  });
  return { state, openAlertId: alert && alert.status !== 'RESOLVED' ? state.openAlertId : null };
}

export async function activeRulesFor(
  deps: WorkerDeps,
  contractRefId: string,
  type: AlertRule['type'],
) {
  return deps.prisma.alertRule.findMany({
    where: { enabled: true, type, OR: [{ contractRefId }, { contractRefId: null }] },
  });
}

/**
 * Records an alert that isn't tied to a rule or contract (e.g. a destination was disabled) and
 * notifies the default destinations, except any listed in `excludeDestinationIds`.
 */
export async function raiseSystemAlert(
  deps: WorkerDeps,
  params: {
    severity: AlertSeverity;
    title: string;
    message: string;
    context: Record<string, unknown>;
    excludeDestinationIds?: string[];
  },
): Promise<string> {
  const prefs = await loadPreferences(deps);
  const exclude = new Set(params.excludeDestinationIds ?? []);
  const targets = await deps.prisma.notificationDestination.findMany({
    where: {
      id: { in: prefs.defaultDestinationIds.filter((id) => !exclude.has(id)) },
      enabled: true,
    },
    select: { id: true },
  });
  const alert = await deps.prisma.alert.create({
    data: {
      severity: params.severity,
      title: params.title.slice(0, 500),
      message: params.message.slice(0, 5000),
      context: params.context as Prisma.InputJsonValue,
      triggeredAt: deps.now(),
      deliveries: {
        create: targets.map((t) => ({
          destinationId: t.id,
          kind: 'alert.triggered',
          maxAttempts: deps.config.WEBHOOK_MAX_ATTEMPTS,
        })),
      },
    },
    include: { deliveries: { select: { id: true } } },
  });
  deps.logger.warn({ alertId: alert.id, title: params.title }, 'system alert raised');
  for (const d of alert.deliveries) await deps.enqueueDelivery(d.id);
  return alert.id;
}
