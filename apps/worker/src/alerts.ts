import type { AlertRule, AlertSeverity, Contract, Prisma } from '@stellar-health/db';
import type { AlertDescription } from '@stellar-health/alert-engine';
import { notificationPreferencesSchema } from '@stellar-health/shared-types';
import type { WorkerDeps } from './deps';

const PREFERENCES_KEY = 'notificationPreferences';

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

  const { alertId, deliveryIds } = await deps.prisma.$transaction(async (tx) => {
    const alert = await tx.alert.create({
      data: {
        ruleId: rule.id,
        contractRefId: contract.id,
        severity: params.severity,
        title: description.title.slice(0, 500),
        message: description.message.slice(0, 5000),
        context: description.context as Prisma.InputJsonValue,
        triggeredAt: now,
        deliveries: {
          create: destinationIds.map((destinationId) => ({
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
    return { alertId: alert.id, deliveryIds: alert.deliveries.map((d) => d.id) };
  });

  deps.metrics.alertsTriggered.labels(rule.type, params.severity).inc();
  deps.logger.info(
    { alertId, ruleId: rule.id, contractRefId: contract.id, deliveries: deliveryIds.length },
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
