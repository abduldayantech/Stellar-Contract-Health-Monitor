import type { WorkerDeps } from './deps';
import { raiseSystemAlert } from './alerts';

/** A delivery to this destination succeeded: clear the failure streak. */
export async function recordDestinationSuccess(deps: WorkerDeps, destinationId: string) {
  await deps.prisma.notificationDestination.updateMany({
    where: { id: destinationId, consecutiveFailures: { gt: 0 } },
    data: { consecutiveFailures: 0, firstFailureAt: null },
  });
}

/**
 * A delivery failed for good. Extends the destination's failure streak and, once it reaches
 * DESTINATION_DISABLE_AFTER_FAILURES over at least DESTINATION_DISABLE_MIN_HOURS, disables the
 * destination and raises a system alert to the default destinations.
 */
export async function recordDestinationFailure(
  deps: WorkerDeps,
  destinationId: string,
  lastError: string,
): Promise<{ disabled: boolean }> {
  const now = deps.now();
  const current = await deps.prisma.notificationDestination.findUnique({
    where: { id: destinationId },
    select: { enabled: true, firstFailureAt: true },
  });
  // Deliveries to a disabled destination fail on purpose; they don't count.
  if (!current?.enabled) return { disabled: false };
  const d = await deps.prisma.notificationDestination.update({
    where: { id: destinationId },
    data: {
      consecutiveFailures: { increment: 1 },
      lastFailureAt: now,
      ...(current.firstFailureAt ? {} : { firstFailureAt: now }),
    },
  });

  const threshold = deps.config.DESTINATION_DISABLE_AFTER_FAILURES;
  if (threshold === 0 || d.consecutiveFailures < threshold) return { disabled: false };
  const since = d.firstFailureAt ?? now;
  const spanHours = (now.getTime() - since.getTime()) / 3600_000;
  if (spanHours < deps.config.DESTINATION_DISABLE_MIN_HOURS) return { disabled: false };

  const reason =
    `Disabled automatically after ${d.consecutiveFailures} failed deliveries in a row since ${since.toISOString()}. Last error: ${lastError}`.slice(
      0,
      1000,
    );
  // Only the update that flips `enabled` raises the alert, even with concurrent workers.
  const flipped = await deps.prisma.notificationDestination.updateMany({
    where: { id: destinationId, enabled: true },
    data: { enabled: false, disabledReason: reason, disabledAt: now },
  });
  if (flipped.count === 0) return { disabled: false };

  await raiseSystemAlert(deps, {
    severity: 'WARNING',
    title: `Notification destination "${d.name}" was disabled`,
    message: `${reason}\n\nFix the receiver, then re-enable the destination under Alerts → Rules → Notification destinations.`,
    context: {
      system: 'destination.disabled',
      destinationId,
      destinationName: d.name,
      consecutiveFailures: d.consecutiveFailures,
      firstFailureAt: since.toISOString(),
    },
    excludeDestinationIds: [destinationId],
  });
  return { disabled: true };
}
