'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import useSWRInfinite from 'swr/infinite';
import {
  Alert,
  AlertStatusBadge,
  Button,
  Card,
  DeliveryStatusBadge,
  EmptyState,
  Field,
  Select,
  SeverityBadge,
  Spinner,
  cn,
  formatDateTime,
  shortId,
  timeAgo,
} from '@stellar-health/ui';
import { PageHeader } from '@/components/app-shell';
import { api, errorMessage, qs, useApi } from '@/lib/api';
import type { AlertItem, Contract, Delivery, Page } from '@/lib/types';

function HistoryPage() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const status = params.get('status') ?? '';
  const deliveryStatus = params.get('deliveryStatus') ?? '';
  const contractRefId = params.get('contractRefId') ?? '';
  const focus = params.get('alert');
  const [expanded, setExpanded] = useState<string | null>(focus);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (focus) {
      setExpanded(focus);
      setTimeout(
        () => document.getElementById(`alert-${focus}`)?.scrollIntoView({ block: 'center' }),
        300,
      );
    }
  }, [focus]);

  const contracts = useApi<Page<Contract>>('/contracts');
  const summary = useApi<{ byStatus: Record<string, number>; failedDeliveries: number }>(
    '/alerts/summary',
    { refreshInterval: 15_000 },
  );
  const { data, size, setSize, isLoading, isValidating, mutate } = useSWRInfinite<Page<AlertItem>>(
    (index, prev) => {
      if (prev && !prev.nextCursor) return null;
      return `/alerts${qs({ status, deliveryStatus, contractRefId, limit: 30, cursor: index === 0 ? undefined : (prev?.nextCursor ?? undefined) })}`;
    },
    (p: string) => api<Page<AlertItem>>(p),
    { refreshInterval: 15_000 },
  );
  const alerts = data?.flatMap((p) => p.items) ?? [];
  const hasMore = Boolean(data?.[data.length - 1]?.nextCursor);

  function setFilter(key: string, value: string) {
    const sp = new URLSearchParams(params.toString());
    if (value) sp.set(key, value);
    else sp.delete(key);
    sp.delete('alert');
    router.replace(`${pathname}${sp.toString() ? `?${sp}` : ''}`);
  }

  async function act(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
      await Promise.all([mutate(), summary.mutate()]);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  const counts = summary.data?.byStatus ?? {};

  return (
    <div className="space-y-4">
      <PageHeader
        title="Alert history"
        description="Every alert raised by your rules, and what happened to each notification."
      />

      <div className="flex flex-wrap gap-2" role="group" aria-label="Status">
        {[
          ['', 'All'],
          ['TRIGGERED', `Triggered (${counts.TRIGGERED ?? 0})`],
          ['ACKNOWLEDGED', `Acknowledged (${counts.ACKNOWLEDGED ?? 0})`],
          ['RESOLVED', `Resolved (${counts.RESOLVED ?? 0})`],
        ].map(([value, label]) => (
          <button
            key={value}
            onClick={() => setFilter('status', value!)}
            aria-pressed={status === value}
            className={cn(
              'rounded-full px-3 py-1 text-xs font-medium ring-1 ring-inset',
              status === value
                ? 'bg-indigo-600 text-white ring-indigo-600'
                : 'bg-white text-slate-700 ring-slate-300 hover:bg-slate-50 dark:bg-slate-900 dark:text-slate-300 dark:ring-slate-700',
            )}
          >
            {label}
          </button>
        ))}
        <button
          onClick={() => setFilter('deliveryStatus', deliveryStatus === 'FAILED' ? '' : 'FAILED')}
          aria-pressed={deliveryStatus === 'FAILED'}
          className={cn(
            'rounded-full px-3 py-1 text-xs font-medium ring-1 ring-inset',
            deliveryStatus === 'FAILED'
              ? 'bg-rose-600 text-white ring-rose-600'
              : 'bg-white text-rose-700 ring-rose-300 hover:bg-rose-50 dark:bg-slate-900 dark:text-rose-300 dark:ring-rose-900',
          )}
        >
          Failed notifications ({summary.data?.failedDeliveries ?? 0})
        </button>
        <div className="ml-auto w-56">
          <Field label={<span className="sr-only">Contract</span>} htmlFor="h-contract">
            <Select
              id="h-contract"
              value={contractRefId}
              onChange={(e) => setFilter('contractRefId', e.target.value)}
            >
              <option value="">All contracts</option>
              {contracts.data?.items.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label ?? shortId(c.contractId)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </div>

      {error && <Alert>{error}</Alert>}

      <Card>
        {isLoading ? (
          <div className="p-6">
            <Spinner />
          </div>
        ) : alerts.length === 0 ? (
          <EmptyState
            title="No alerts"
            description="Alerts appear here when a rule's condition is met."
          />
        ) : (
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {alerts.map((a) => {
              const open = expanded === a.id;
              const failed = a.deliveries.filter((d) => d.status === 'FAILED').length;
              return (
                <li
                  key={a.id}
                  id={`alert-${a.id}`}
                  className={cn(focus === a.id && 'bg-indigo-50/50 dark:bg-indigo-950/30')}
                  data-testid="alert-row"
                >
                  <div className="flex flex-wrap items-start gap-3 px-4 py-3">
                    <button
                      className="min-w-0 flex-1 space-y-1 text-left"
                      onClick={() => setExpanded(open ? null : a.id)}
                      aria-expanded={open}
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <SeverityBadge severity={a.severity} />
                        <AlertStatusBadge status={a.status} />
                        {a.deliveries.length > 0 && (
                          <DeliveryStatusBadge
                            status={
                              failed
                                ? 'FAILED'
                                : a.deliveries.every((d) => d.status === 'SUCCEEDED')
                                  ? 'SUCCEEDED'
                                  : 'PENDING'
                            }
                          >
                            {failed
                              ? `${failed} failed`
                              : `${a.deliveries.filter((d) => d.status === 'SUCCEEDED').length}/${a.deliveries.length} sent`}
                          </DeliveryStatusBadge>
                        )}
                        <span
                          className="text-xs text-slate-500"
                          title={formatDateTime(a.triggeredAt)}
                        >
                          {timeAgo(a.triggeredAt)}
                        </span>
                      </div>
                      <p className="break-all text-sm font-medium text-slate-900 dark:text-slate-100">
                        {a.title}
                      </p>
                      <p className="text-xs text-slate-500">
                        {a.rule?.name ?? (a.context?.system ? 'System' : 'Deleted rule')}
                        {a.contract && (
                          <>
                            {' · '}
                            {a.contract.label ?? shortId(a.contract.contractId)}
                          </>
                        )}
                      </p>
                    </button>
                    <div className="flex gap-1">
                      {a.status === 'TRIGGERED' && (
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() =>
                            act(() => api(`/alerts/${a.id}/acknowledge`, { method: 'POST' }))
                          }
                        >
                          Acknowledge
                        </Button>
                      )}
                      {a.status !== 'RESOLVED' && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            act(() => api(`/alerts/${a.id}/resolve`, { method: 'POST' }))
                          }
                        >
                          Resolve
                        </Button>
                      )}
                    </div>
                  </div>
                  {open && (
                    <AlertDetails
                      alert={a}
                      onRetry={(d) =>
                        act(() => api(`/deliveries/${d.id}/retry`, { method: 'POST' }))
                      }
                    />
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
      {hasMore && (
        <div className="flex justify-center">
          <Button variant="secondary" loading={isValidating} onClick={() => setSize(size + 1)}>
            Load more
          </Button>
        </div>
      )}
    </div>
  );
}

function AlertDetails({ alert, onRetry }: { alert: AlertItem; onRetry: (d: Delivery) => void }) {
  return (
    <div className="space-y-3 border-t border-slate-100 bg-slate-50 px-4 py-3 text-sm dark:border-slate-800 dark:bg-slate-900/60">
      <p className="whitespace-pre-line text-slate-700 dark:text-slate-300">{alert.message}</p>
      <dl className="grid gap-2 text-xs sm:grid-cols-3">
        <div>
          <dt className="text-slate-500">Triggered</dt>
          <dd>{formatDateTime(alert.triggeredAt)}</dd>
        </div>
        {alert.acknowledgedAt && (
          <div>
            <dt className="text-slate-500">Acknowledged</dt>
            <dd>
              {formatDateTime(alert.acknowledgedAt)}{' '}
              {alert.acknowledgedBy && `by ${alert.acknowledgedBy}`}
            </dd>
          </div>
        )}
        {alert.resolvedAt && (
          <div>
            <dt className="text-slate-500">Resolved</dt>
            <dd>{formatDateTime(alert.resolvedAt)}</dd>
          </div>
        )}
        {alert.contract && (
          <div>
            <dt className="text-slate-500">Contract</dt>
            <dd>
              <Link
                className="text-indigo-600 hover:underline dark:text-indigo-400"
                href={`/contracts/${alert.contract.id}`}
              >
                {alert.contract.label ?? shortId(alert.contract.contractId)}
              </Link>
            </dd>
          </div>
        )}
      </dl>
      <div>
        <p className="mb-1 text-xs font-medium text-slate-500">Notifications</p>
        {alert.deliveries.length === 0 ? (
          <p className="text-xs text-slate-500">No destinations were configured for this rule.</p>
        ) : (
          <ul className="space-y-1">
            {alert.deliveries.map((d) => (
              <li
                key={d.id}
                className="flex flex-wrap items-center gap-2 text-xs"
                data-testid="delivery-row"
              >
                <DeliveryStatusBadge status={d.status} />
                <span className="font-medium">{d.destination?.name ?? 'Deleted destination'}</span>
                <span className="text-slate-500">
                  {d.kind === 'alert.resolved' ? 'resolution · ' : ''}
                  {d.attempts}/{d.maxAttempts} attempts
                  {d.responseStatus ? ` · HTTP ${d.responseStatus}` : ''}
                  {d.deliveredAt
                    ? ` · delivered ${timeAgo(d.deliveredAt)}`
                    : d.lastAttemptAt
                      ? ` · last try ${timeAgo(d.lastAttemptAt)}`
                      : ''}
                </span>
                {d.lastError && (
                  <span className="text-rose-600 dark:text-rose-400">{d.lastError}</span>
                )}
                {d.status === 'FAILED' && (
                  <Button size="sm" variant="secondary" onClick={() => onRetry(d)}>
                    Retry
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      <details>
        <summary className="cursor-pointer text-xs text-slate-500">Context</summary>
        <pre className="mt-1 max-h-72 overflow-auto rounded bg-white p-2 font-mono text-xs dark:bg-slate-950">
          {JSON.stringify(alert.context, null, 2)}
        </pre>
      </details>
    </div>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<Spinner />}>
      <HistoryPage />
    </Suspense>
  );
}
