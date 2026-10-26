'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import {
  AlertStatusBadge,
  Button,
  Card,
  CardHeader,
  ContractSummaryCard,
  EmptyState,
  Field,
  Input,
  SeverityBadge,
  Spinner,
  Stat,
  StatusDot,
  timeAgo,
} from '@stellar-health/ui';
import { PageHeader } from '@/components/app-shell';
import { EventTable } from '@/components/event-table';
import { qs, useApi } from '@/lib/api';
import type { AlertItem, Contract, EventItem, Page, Status } from '@/lib/types';

const SEARCH_DEBOUNCE_MS = 300;

function Overview() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const query = params.get('q') ?? '';
  const paramsKey = params.toString();
  const [draft, setDraft] = useState(query);
  // Ignore the URL echo of a query this page just wrote, so a late navigation
  // does not wipe characters typed while that update was in flight.
  const pushed = useRef(query);

  useEffect(() => {
    if (query === pushed.current) return;
    pushed.current = query;
    setDraft(query);
  }, [query]);

  useEffect(() => {
    const next = draft.trim();
    const id = window.setTimeout(() => {
      const sp = new URLSearchParams(paramsKey);
      if ((sp.get('q') ?? '') === next) return;
      pushed.current = next;
      if (next) sp.set('q', next);
      else sp.delete('q');
      const s = sp.toString();
      router.replace(s ? `${pathname}?${s}` : pathname, { scroll: false });
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [draft, paramsKey, pathname, router]);

  const catalog = useApi<Page<Contract>>('/contracts', { refreshInterval: 15_000 });
  const contracts = useApi<Page<Contract>>(`/contracts${qs({ search: query || undefined })}`, {
    refreshInterval: 15_000,
  });
  const events = useApi<Page<EventItem>>('/events?limit=10', { refreshInterval: 10_000 });
  const alerts = useApi<Page<AlertItem>>('/alerts?limit=6', { refreshInterval: 15_000 });
  const status = useApi<Status>('/status', { refreshInterval: 15_000 });

  const allItems = catalog.data?.items ?? [];
  const items = contracts.data?.items ?? [];
  const totals = status.data?.totals;
  const unhealthy = allItems.filter(
    (c) => c.health === 'critical' || c.health === 'warning',
  ).length;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Overview"
        description="Health and activity of your monitored Stellar contracts"
        actions={
          <Link href="/contracts/new">
            <Button>Add contract</Button>
          </Link>
        }
      />

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="Summary">
        <Stat
          label="Monitored contracts"
          value={allItems.length}
          hint={unhealthy ? `${unhealthy} need attention` : 'All healthy'}
          tone={unhealthy ? 'yellow' : undefined}
        />
        <Stat label="Events (24h)" value={totals ? totals.events24h.toLocaleString() : '—'} />
        <Stat
          label="Open alerts"
          value={totals?.openAlerts ?? '—'}
          tone={totals?.openAlerts ? 'red' : undefined}
        />
        <Stat
          label="Failed notifications (24h)"
          value={totals?.failedDeliveries24h ?? '—'}
          tone={totals?.failedDeliveries24h ? 'red' : undefined}
        />
      </section>

      <div className="grid gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          <section aria-labelledby="contracts-heading">
            <h2 id="contracts-heading" className="mb-3 text-sm font-semibold">
              Contracts
            </h2>
            {!catalog.data && catalog.isLoading ? (
              <Spinner />
            ) : allItems.length === 0 && !query ? (
              <Card>
                <EmptyState
                  title="No contracts yet"
                  description="Register a deployed contract to start collecting its events and tracking storage expiry."
                  action={
                    <Link href="/contracts/new">
                      <Button>Add your first contract</Button>
                    </Link>
                  }
                />
              </Card>
            ) : (
              <>
                <div className="mb-3 max-w-md">
                  <Field label="Search contracts" htmlFor="contract-search">
                    <Input
                      id="contract-search"
                      type="search"
                      value={draft}
                      placeholder="Label or contract ID"
                      onChange={(e) => setDraft(e.target.value)}
                    />
                  </Field>
                </div>
                {!contracts.data && contracts.isLoading ? (
                  <Spinner />
                ) : items.length === 0 ? (
                  <Card>
                    <EmptyState
                      title="No contracts match"
                      description="Try a different label or contract ID."
                    />
                  </Card>
                ) : (
                  <div className="grid gap-3 sm:grid-cols-2">
                    {items.map((c) => (
                      <ContractSummaryCard
                        key={c.id}
                        contract={c}
                        href={`/contracts/${c.id}`}
                        LinkComponent={Link}
                      />
                    ))}
                  </div>
                )}
              </>
            )}
          </section>

          <Card>
            <CardHeader
              title="Latest events"
              actions={
                <Link
                  href="/events"
                  className="text-xs text-indigo-600 hover:underline dark:text-indigo-400"
                >
                  Open explorer →
                </Link>
              }
            />
            {events.data && events.data.items.length > 0 ? (
              <EventTable events={events.data.items} />
            ) : (
              <EmptyState
                title={events.isLoading ? 'Loading…' : 'No events yet'}
                description="Events appear here within seconds of being emitted on-chain."
              />
            )}
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader
              title="Recent alerts"
              actions={
                <Link
                  href="/alerts/history"
                  className="text-xs text-indigo-600 hover:underline dark:text-indigo-400"
                >
                  History →
                </Link>
              }
            />
            {alerts.data && alerts.data.items.length > 0 ? (
              <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                {alerts.data.items.map((a) => (
                  <li key={a.id} className="px-4 py-3">
                    <Link href={`/alerts/history?alert=${a.id}`} className="block space-y-1">
                      <div className="flex items-center gap-2">
                        <SeverityBadge severity={a.severity} />
                        <AlertStatusBadge status={a.status} />
                        <span className="ml-auto text-xs text-slate-500 dark:text-slate-400">
                          {timeAgo(a.triggeredAt)}
                        </span>
                      </div>
                      <p className="line-clamp-2 text-sm text-slate-800 dark:text-slate-200">
                        {a.title}
                      </p>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState
                title="No alerts"
                description="Configure alert rules to get notified about events and expiring storage."
              />
            )}
          </Card>

          <Card id="status">
            <CardHeader title="Monitoring status" />
            {status.data ? (
              <ul className="space-y-2 px-4 py-3 text-sm">
                <StatusRow
                  ok={status.data.database.ok}
                  label="Database"
                  detail={`${status.data.database.latencyMs} ms`}
                />
                <StatusRow
                  ok={status.data.redis.ok}
                  label="Queue (Redis)"
                  detail={`${status.data.redis.latencyMs} ms`}
                />
                <StatusRow
                  ok={status.data.workerHealthy}
                  label="Event worker"
                  detail={
                    status.data.workers[0]
                      ? `beat ${timeAgo(status.data.workers[0].lastBeatAt)}`
                      : 'not running'
                  }
                />
                {status.data.networks
                  .filter((n) => n.configured && n.latestLedger)
                  .map((n) => (
                    <StatusRow
                      key={n.network}
                      ok={!n.lastError}
                      label={`RPC ${n.network.toLowerCase()}`}
                      detail={`ledger ${n.latestLedger?.toLocaleString()}`}
                    />
                  ))}
              </ul>
            ) : (
              <div className="px-4 py-3">
                <Spinner />
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

export default function OverviewPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <Overview />
    </Suspense>
  );
}

function StatusRow({ ok, label, detail }: { ok: boolean; label: string; detail?: string }) {
  return (
    <li className="flex items-center gap-2">
      <StatusDot tone={ok ? 'green' : 'red'} label={ok ? 'OK' : 'Problem'} />
      <span>{label}</span>
      <span className="ml-auto text-xs text-slate-500 dark:text-slate-400">{detail}</span>
    </li>
  );
}
