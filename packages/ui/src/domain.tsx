import type { ReactNode } from 'react';
import { Badge, Card, StatusDot, type Tone } from './components';
import { formatLedgers, shortId, timeAgo } from './format';

export type ContractHealth = 'healthy' | 'warning' | 'critical' | 'paused' | 'pending';

const healthTone: Record<ContractHealth, Tone> = {
  healthy: 'green',
  warning: 'yellow',
  critical: 'red',
  paused: 'slate',
  pending: 'blue',
};

const healthLabel: Record<ContractHealth, string> = {
  healthy: 'Healthy',
  warning: 'Warning',
  critical: 'Critical',
  paused: 'Paused',
  pending: 'Starting',
};

export function HealthBadge({ health }: { health: ContractHealth }) {
  return (
    <Badge tone={healthTone[health]}>
      <StatusDot tone={healthTone[health]} pulse={health === 'critical'} />
      {healthLabel[health]}
    </Badge>
  );
}

export function NetworkBadge({ network }: { network: string }) {
  const tone: Tone = network === 'MAINNET' ? 'indigo' : network === 'TESTNET' ? 'blue' : 'neutral';
  return <Badge tone={tone}>{network.toLowerCase()}</Badge>;
}

export function SeverityBadge({ severity }: { severity: string }) {
  const tone: Tone = severity === 'CRITICAL' ? 'red' : severity === 'WARNING' ? 'yellow' : 'blue';
  return <Badge tone={tone}>{severity.toLowerCase()}</Badge>;
}

export function AlertStatusBadge({ status }: { status: string }) {
  const tone: Tone =
    status === 'TRIGGERED' ? 'red' : status === 'ACKNOWLEDGED' ? 'yellow' : 'green';
  return <Badge tone={tone}>{status.toLowerCase()}</Badge>;
}

export function DeliveryStatusBadge({
  status,
  children,
}: {
  status: string;
  children?: ReactNode;
}) {
  const tone: Tone = status === 'SUCCEEDED' ? 'green' : status === 'FAILED' ? 'red' : 'yellow';
  return <Badge tone={tone}>{children ?? status.toLowerCase()}</Badge>;
}

export interface ContractSummary {
  id: string;
  contractId: string;
  network: string;
  label: string | null;
  health: ContractHealth;
  eventCount: number;
  lastEventAt: string | null;
  lastPolledAt: string | null;
  openAlerts: number;
  nearestExpiryLedgers: number | null;
  lastError: string | null;
}

/** Compact card summarising one monitored contract. */
export function ContractSummaryCard({
  contract,
  href,
  LinkComponent,
}: {
  contract: ContractSummary;
  href: string;
  LinkComponent?: (p: { href: string; className?: string; children: ReactNode }) => ReactNode;
}) {
  const Link =
    LinkComponent ??
    ((p: { href: string; className?: string; children: ReactNode }) => <a {...p} />);
  return (
    <Card className="transition-shadow hover:shadow-md">
      <Link
        href={href}
        className="block space-y-3 p-4 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">
              {contract.label ?? shortId(contract.contractId, 8, 6)}
            </p>
            <p
              className="truncate font-mono text-xs text-slate-500 dark:text-slate-400"
              title={contract.contractId}
            >
              {shortId(contract.contractId, 10, 8)}
            </p>
          </div>
          <HealthBadge health={contract.health} />
        </div>
        <dl className="grid grid-cols-3 gap-2 text-xs">
          <div>
            <dt className="text-slate-500 dark:text-slate-400">Events</dt>
            <dd className="font-medium tabular-nums text-slate-900 dark:text-slate-100">
              {contract.eventCount.toLocaleString()}
            </dd>
          </div>
          <div>
            <dt className="text-slate-500 dark:text-slate-400">Last event</dt>
            <dd className="font-medium text-slate-900 dark:text-slate-100">
              {timeAgo(contract.lastEventAt)}
            </dd>
          </div>
          <div>
            <dt className="text-slate-500 dark:text-slate-400">Open alerts</dt>
            <dd
              className={
                contract.openAlerts > 0
                  ? 'font-medium text-rose-600 dark:text-rose-400'
                  : 'font-medium text-slate-900 dark:text-slate-100'
              }
            >
              {contract.openAlerts}
            </dd>
          </div>
        </dl>
        <div className="flex items-center justify-between gap-2 text-xs text-slate-500 dark:text-slate-400">
          <NetworkBadge network={contract.network} />
          <span className="truncate" title="Nearest storage expiry">
            TTL: {formatLedgers(contract.nearestExpiryLedgers)}
          </span>
        </div>
        {contract.lastError && (
          <p
            className="truncate text-xs text-rose-600 dark:text-rose-400"
            title={contract.lastError}
          >
            {contract.lastError}
          </p>
        )}
      </Link>
    </Card>
  );
}

/** Horizontal bar showing how much TTL is left relative to a reference window. */
export function TtlBar({
  ledgersRemaining,
  reference = 535_680,
}: {
  ledgersRemaining: number | null;
  reference?: number;
}) {
  if (ledgersRemaining === null)
    return <span className="text-xs text-slate-500 dark:text-slate-400">—</span>;
  const pct = Math.max(0, Math.min(100, (ledgersRemaining / reference) * 100));
  const color =
    ledgersRemaining <= 0
      ? 'bg-rose-500'
      : ledgersRemaining < 17_280 * 7
        ? 'bg-amber-500'
        : 'bg-emerald-500';
  return (
    <div
      className="h-1.5 w-24 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800"
      role="meter"
      aria-label="Storage TTL remaining"
      aria-valuenow={Math.max(0, Math.min(reference, ledgersRemaining))}
      aria-valuemin={0}
      aria-valuemax={reference}
      aria-valuetext={
        ledgersRemaining <= 0 ? 'Expired' : `${ledgersRemaining.toLocaleString()} ledgers left`
      }
    >
      <div
        className={`h-full ${color}`}
        style={{ width: `${Math.max(pct, ledgersRemaining > 0 ? 2 : 100)}%` }}
      />
    </div>
  );
}
