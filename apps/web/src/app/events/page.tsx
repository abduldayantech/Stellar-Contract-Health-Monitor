'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState, type FormEvent } from 'react';
import useSWRInfinite from 'swr/infinite';
import { Alert, Button, Card, EmptyState, Field, Input, Select, Spinner } from '@stellar-health/ui';
import { PageHeader } from '@/components/app-shell';
import { EventTable } from '@/components/event-table';
import { api, errorMessage, qs, useApi } from '@/lib/api';
import type { Contract, EventItem, Page } from '@/lib/types';

const FILTER_KEYS = ['contractRefId', 'topic', 'txHash', 'from', 'to', 'type'] as const;
type Filters = Record<(typeof FILTER_KEYS)[number], string>;

function toIso(local: string): string | undefined {
  if (!local) return undefined;
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

function EventsExplorer() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const applied = Object.fromEntries(FILTER_KEYS.map((k) => [k, params.get(k) ?? ''])) as Filters;
  const [draft, setDraft] = useState<Filters>(applied);
  const paramsKey = params.toString();
  useEffect(() => {
    setDraft(Object.fromEntries(FILTER_KEYS.map((k) => [k, params.get(k) ?? ''])) as Filters);
  }, [paramsKey]);

  const contracts = useApi<Page<Contract>>('/contracts?all=1');
  const topics = useApi<{ items: { topic: string; count: number }[] }>(
    `/events/topics${qs({ contractRefId: applied.contractRefId })}`,
  );

  const txError =
    applied.txHash && !/^[0-9a-fA-F]{64}$/.test(applied.txHash)
      ? 'Transaction hashes are 64 hex characters'
      : null;
  const query = {
    contractRefId: applied.contractRefId,
    topic: applied.topic,
    txHash: txError ? undefined : applied.txHash,
    from: toIso(applied.from),
    to: toIso(applied.to),
    type: applied.type,
    limit: 50,
  };
  const { data, error, size, setSize, isLoading, isValidating, mutate } = useSWRInfinite<
    Page<EventItem>
  >(
    (index, prev) => {
      if (prev && !prev.nextCursor) return null;
      return `/events${qs({ ...query, cursor: index === 0 ? undefined : (prev?.nextCursor ?? undefined) })}`;
    },
    (path: string) => api<Page<EventItem>>(path),
    { revalidateFirstPage: true, refreshInterval: 15_000 },
  );
  const events = data?.flatMap((p) => p.items) ?? [];
  const hasMore = Boolean(data?.[data.length - 1]?.nextCursor);

  function apply(next: Filters) {
    const sp = new URLSearchParams();
    for (const k of FILTER_KEYS) if (next[k]) sp.set(k, next[k]);
    router.replace(`${pathname}${sp.toString() ? `?${sp}` : ''}`);
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    apply(draft);
  }

  const activeCount = FILTER_KEYS.filter((k) => applied[k]).length;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Events"
        description="Contract events stored by the monitor. Click a row for details, or a topic to filter by it."
      />
      <Card className="p-4">
        <form
          onSubmit={onSubmit}
          className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6"
          aria-label="Event filters"
        >
          <Field label="Contract" htmlFor="f-contract">
            <Select
              id="f-contract"
              value={draft.contractRefId}
              onChange={(e) => setDraft({ ...draft, contractRefId: e.target.value })}
            >
              <option value="">All contracts</option>
              {contracts.data?.items.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label ?? c.contractId.slice(0, 10)} ({c.network.toLowerCase()})
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Topic" htmlFor="f-topic" hint="Exact match on any topic">
            <Input
              id="f-topic"
              list="topic-suggestions"
              value={draft.topic}
              onChange={(e) => setDraft({ ...draft, topic: e.target.value })}
              placeholder="transfer"
            />
            <datalist id="topic-suggestions">
              {topics.data?.items.map((t) => (
                <option key={t.topic} value={t.topic}>
                  {t.count} events
                </option>
              ))}
            </datalist>
          </Field>
          <Field label="Transaction hash" htmlFor="f-tx" error={txError}>
            <Input
              id="f-tx"
              value={draft.txHash}
              onChange={(e) => setDraft({ ...draft, txHash: e.target.value.trim() })}
              className="font-mono"
              placeholder="64 hex chars"
            />
          </Field>
          <Field label="From" htmlFor="f-from">
            <Input
              id="f-from"
              type="datetime-local"
              value={draft.from}
              onChange={(e) => setDraft({ ...draft, from: e.target.value })}
            />
          </Field>
          <Field label="To" htmlFor="f-to">
            <Input
              id="f-to"
              type="datetime-local"
              value={draft.to}
              onChange={(e) => setDraft({ ...draft, to: e.target.value })}
            />
          </Field>
          <Field label="Type" htmlFor="f-type">
            <Select
              id="f-type"
              value={draft.type}
              onChange={(e) => setDraft({ ...draft, type: e.target.value })}
            >
              <option value="">Any</option>
              <option value="contract">contract</option>
              <option value="system">system</option>
            </Select>
          </Field>
          <div className="flex flex-wrap items-center gap-2 sm:col-span-2 lg:col-span-6">
            <Button type="submit">Apply filters</Button>
            {activeCount > 0 && (
              <Button
                type="button"
                variant="ghost"
                onClick={() =>
                  apply({ contractRefId: '', topic: '', txHash: '', from: '', to: '', type: '' })
                }
              >
                Clear ({activeCount})
              </Button>
            )}
            <span className="ml-auto text-xs text-slate-500">
              {isValidating && !isLoading
                ? 'Refreshing…'
                : `${events.length.toLocaleString()} shown${hasMore ? '+' : ''}`}
            </span>
          </div>
        </form>
      </Card>

      {error && (
        <Alert title="Could not load events">
          {errorMessage(error)}{' '}
          <button className="underline" onClick={() => mutate()}>
            Retry
          </button>
        </Alert>
      )}

      <Card>
        {isLoading ? (
          <div className="p-6">
            <Spinner />
          </div>
        ) : events.length === 0 ? (
          <EmptyState
            title="No events match"
            description={
              activeCount
                ? 'Try removing some filters.'
                : 'Events appear here once a monitored contract emits them.'
            }
          />
        ) : (
          <EventTable events={events} onTopicClick={(t) => apply({ ...applied, topic: t })} />
        )}
      </Card>
      {hasMore && (
        <div className="flex justify-center">
          <Button
            variant="secondary"
            loading={isValidating && size > (data?.length ?? 0)}
            onClick={() => setSize(size + 1)}
          >
            Load more
          </Button>
        </div>
      )}
    </div>
  );
}

export default function EventsPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <EventsExplorer />
    </Suspense>
  );
}
