'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import {
  Alert,
  AlertStatusBadge,
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  Field,
  HealthBadge,
  Input,
  Mono,
  NetworkBadge,
  Select,
  SeverityBadge,
  Spinner,
  Stat,
  Table,
  Td,
  Th,
  TtlBar,
  formatDateTime,
  formatLedgers,
  timeAgo,
} from '@stellar-health/ui';
import { PageHeader } from '@/components/app-shell';
import { ActivityChart } from '@/components/activity-chart';
import { ContractLabel } from '@/components/contract-label';
import { CopyButton } from '@/components/copy-button';
import { EventTable } from '@/components/event-table';
import { ExtendCommand, needsExtending } from '@/components/extend-command';
import { SilencesPanel } from '@/components/silences-panel';
import { api, errorMessage, useApi } from '@/lib/api';
import { describeRule } from '@/lib/rules';
import type { ContractDetail, EventItem, Page, Silence, StorageEntry } from '@/lib/types';

export default function ContractDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const contract = useApi<ContractDetail>(`/contracts/${id}`, { refreshInterval: 10_000 });
  const silences = useApi<{ items: Silence[] }>(`/silences?contractRefId=${id}`);
  const events = useApi<Page<EventItem>>(`/events?contractRefId=${id}&limit=20`, {
    refreshInterval: 10_000,
  });
  const [hours, setHours] = useState(24);
  const activity = useApi<{ bucket: 'hour' | 'day'; points: { t: string; count: number }[] }>(
    `/contracts/${id}/activity?hours=${hours}`,
    {
      refreshInterval: 60_000,
    },
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  if (contract.error) {
    return <Alert title="Could not load contract">{errorMessage(contract.error)}</Alert>;
  }
  const c = contract.data;
  if (!c) return <Spinner />;

  async function run(name: string, fn: () => Promise<unknown>) {
    setBusy(name);
    setActionError(null);
    try {
      await fn();
      await contract.mutate();
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            <ContractLabel id={id} label={c.label} onSaved={() => contract.mutate()} />
            <HealthBadge health={c.health} /> <NetworkBadge network={c.network} />
          </span>
        }
        description={
          <span className="flex flex-wrap items-center gap-2">
            <Mono className="break-all">{c.contractId}</Mono> <CopyButton value={c.contractId} />
          </span>
        }
        actions={
          <>
            <Button
              variant="secondary"
              loading={busy === 'refresh'}
              onClick={() =>
                run('refresh', () => api(`/contracts/${id}/refresh`, { method: 'POST' }))
              }
            >
              Refresh now
            </Button>
            <Button
              variant="secondary"
              loading={busy === 'pause'}
              onClick={() =>
                run('pause', () =>
                  api(`/contracts/${id}`, {
                    method: 'PATCH',
                    body: { status: c.status === 'PAUSED' ? 'ACTIVE' : 'PAUSED' },
                  }),
                )
              }
            >
              {c.status === 'PAUSED' ? 'Resume' : 'Pause'}
            </Button>
            {confirmDelete ? (
              <>
                <Button
                  variant="danger"
                  loading={busy === 'delete'}
                  onClick={async () => {
                    setBusy('delete');
                    try {
                      await api(`/contracts/${id}`, { method: 'DELETE' });
                      router.push('/');
                    } catch (err) {
                      setActionError(errorMessage(err));
                      setBusy(null);
                    }
                  }}
                >
                  Confirm delete
                </Button>
                <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
                  Cancel
                </Button>
              </>
            ) : (
              <Button variant="ghost" onClick={() => setConfirmDelete(true)}>
                Delete
              </Button>
            )}
          </>
        }
      />

      {confirmDelete && (
        <Alert tone="yellow">
          Deleting removes this contract with all stored events, alerts and storage entries. This
          cannot be undone.
        </Alert>
      )}
      {actionError && <Alert>{actionError}</Alert>}
      {c.lastError && (
        <Alert
          title={`Ingestion failing (${c.consecutiveFailures} attempt${c.consecutiveFailures === 1 ? '' : 's'})`}
        >
          {c.lastError}
        </Alert>
      )}
      {c.gapDetectedAt && (
        <Alert tone="yellow" title="Gap in event history">
          On {formatDateTime(c.gapDetectedAt)} ingestion resumed from the oldest ledger the RPC
          still retains, so some events may be missing. This happens if the worker is stopped for
          longer than the RPC retention window.
        </Alert>
      )}

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label="Events stored"
          value={c.eventCount.toLocaleString()}
          hint={`last ${timeAgo(c.lastEventAt)}`}
        />
        <Stat
          label="Ingestion"
          value={
            c.ingestionLagLedgers === null
              ? '—'
              : c.ingestionLagLedgers <= 2
                ? 'Live'
                : `${c.ingestionLagLedgers} behind`
          }
          hint={`polled ${timeAgo(c.lastPolledAt)} · ledger ${c.lastIngestedLedger?.toLocaleString() ?? '—'}`}
          tone={
            c.ingestionLagLedgers !== null && c.ingestionLagLedgers > 100 ? 'yellow' : undefined
          }
        />
        <Stat
          label="Nearest storage expiry"
          value={
            c.nearestExpiryLedgers === null
              ? '—'
              : c.nearestExpiryLedgers <= 0
                ? 'Expired'
                : formatLedgers(c.nearestExpiryLedgers).split(' (')[1]?.replace(')', '')
          }
          hint={
            c.nearestExpiryLedgers !== null
              ? `${c.nearestExpiryLedgers.toLocaleString()} ledgers`
              : undefined
          }
          tone={
            c.nearestExpiryLedgers !== null && c.nearestExpiryLedgers < 17_280 * 7
              ? 'red'
              : undefined
          }
        />
        <Stat
          label="Open alerts"
          value={c.openAlerts}
          tone={c.openAlerts ? 'red' : undefined}
          hint={`${c.alertRules.length} rules apply`}
        />
      </section>

      <Card>
        <CardHeader
          title="Activity"
          actions={
            <Select
              aria-label="Time range"
              value={hours}
              onChange={(e) => setHours(Number(e.target.value))}
              className="w-auto"
            >
              <option value={24}>Last 24 hours</option>
              <option value={168}>Last 7 days</option>
              <option value={720}>Last 30 days</option>
            </Select>
          }
        />
        <div className="px-4 py-3">
          {activity.data ? (
            <ActivityChart
              points={activity.data.points}
              bucket={activity.data.bucket}
              hours={hours}
            />
          ) : (
            <Spinner />
          )}
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Recent events"
          actions={
            <Link
              href={`/events?contractRefId=${id}`}
              className="text-xs text-indigo-600 hover:underline dark:text-indigo-400"
            >
              All events →
            </Link>
          }
        />
        {events.data?.items.length ? (
          <EventTable events={events.data.items} showContract={false} />
        ) : (
          <EmptyState
            title="No events yet"
            description="Invoke the contract and its events will appear here within a few seconds."
          />
        )}
      </Card>

      <StorageSection contract={c} onChange={() => contract.mutate()} />

      <SilencesPanel
        contracts={[c]}
        rules={c.alertRules}
        fixedContractRefId={c.id}
        buttonLabel="Silence for…"
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader
            title="Alert rules"
            description="Rules scoped to this contract plus global rules"
            actions={
              <Link href={`/alerts/rules?contractRefId=${id}`}>
                <Button size="sm" variant="secondary">
                  Add rule
                </Button>
              </Link>
            }
          />
          {c.alertRules.length === 0 ? (
            <EmptyState
              title="No alert rules"
              description="Add a rule to get notified about events, inactivity or expiring storage."
            />
          ) : (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {c.alertRules.map((r) => (
                <li key={r.id} className="flex items-start gap-3 px-4 py-3 text-sm">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">
                      {r.name} {!r.enabled && <Badge tone="slate">disabled</Badge>}{' '}
                      {r.contractRefId === null && <Badge>global</Badge>}
                    </p>
                    <p className="text-xs text-slate-500 dark:text-slate-400">{describeRule(r)}</p>
                  </div>
                  <SeverityBadge severity={r.severity} />
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader
            title="Recent alerts"
            actions={
              <Link
                href={`/alerts/history?contractRefId=${id}`}
                className="text-xs text-indigo-600 hover:underline dark:text-indigo-400"
              >
                History →
              </Link>
            }
          />
          {c.recentAlerts.length === 0 ? (
            <EmptyState title="No alerts triggered" />
          ) : (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {c.recentAlerts.map((a) => (
                <li key={a.id} className="px-4 py-3">
                  <Link href={`/alerts/history?alert=${a.id}`} className="block">
                    <div className="flex items-center gap-2">
                      <SeverityBadge severity={a.severity} />
                      <AlertStatusBadge status={a.status} />
                      {a.silenced && <Badge tone="slate">silenced</Badge>}
                      <span className="ml-auto text-xs text-slate-500 dark:text-slate-400">
                        {timeAgo(a.triggeredAt)}
                      </span>
                    </div>
                    <p className="mt-1 line-clamp-2 break-all text-sm">{a.title}</p>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <SilencesSection
        silences={silences.data?.items}
        contracts={[c]}
        rules={c.alertRules}
        contractRefId={c.id}
        loading={silences.isLoading}
        onChange={() => silences.mutate()}
      />

      <Card className="px-4 py-3 text-xs text-slate-500 dark:text-slate-400">
        <dl className="grid gap-2 sm:grid-cols-3">
          <div>
            <dt>Type</dt>
            <dd className="text-slate-800 dark:text-slate-200">
              {c.executableType === 'wasm' ? 'WASM contract' : 'Stellar Asset Contract'}
            </dd>
          </div>
          {c.wasmHash && (
            <div>
              <dt>WASM hash</dt>
              <dd className="font-mono break-all text-slate-800 dark:text-slate-200">
                {c.wasmHash}
              </dd>
            </div>
          )}
          <div>
            <dt>Monitoring since</dt>
            <dd className="text-slate-800 dark:text-slate-200">
              {formatDateTime(c.createdAt)} (from ledger {c.startLedger.toLocaleString()})
            </dd>
          </div>
        </dl>
      </Card>
    </div>
  );
}

function StorageSection({
  contract,
  onChange,
}: {
  contract: ContractDetail;
  onChange: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState('');
  const [keyType, setKeyType] = useState<'enum_variant' | 'symbol' | 'xdr'>('enum_variant');
  const [key, setKey] = useState('');
  const [durability, setDurability] = useState<'PERSISTENT' | 'TEMPORARY'>('PERSISTENT');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await api(`/contracts/${contract.id}/storage-entries`, {
        method: 'POST',
        body: { label, keyType, key, durability },
      });
      setLabel('');
      setKey('');
      setAdding(false);
      onChange();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader
        title="Monitored storage entries"
        description="Entries are archived (persistent) or deleted (temporary) when their TTL runs out. Instance and code entries are tracked automatically."
        actions={
          <Button size="sm" variant="secondary" onClick={() => setAdding((a) => !a)}>
            {adding ? 'Cancel' : 'Add entry'}
          </Button>
        }
      />
      {adding && (
        <form
          onSubmit={submit}
          className="grid gap-3 border-b border-slate-200 px-4 py-3 sm:grid-cols-2 lg:grid-cols-5 dark:border-slate-800"
        >
          <Field label="Label" htmlFor="se-label">
            <Input
              id="se-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              required
              placeholder="Admin"
            />
          </Field>
          <Field label="Key type" htmlFor="se-type">
            <Select
              id="se-type"
              value={keyType}
              onChange={(e) => setKeyType(e.target.value as typeof keyType)}
            >
              <option value="enum_variant">Enum variant (DataKey::Admin)</option>
              <option value="symbol">Symbol (symbol_short!)</option>
              <option value="xdr">Raw ScVal XDR (base64)</option>
            </Select>
          </Field>
          <Field label="Key" htmlFor="se-key">
            <Input
              id="se-key"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              required
              className="font-mono"
              placeholder={keyType === 'xdr' ? 'AAAADw…' : 'Admin'}
            />
          </Field>
          <Field label="Durability" htmlFor="se-dur">
            <Select
              id="se-dur"
              value={durability}
              onChange={(e) => setDurability(e.target.value as typeof durability)}
            >
              <option value="PERSISTENT">Persistent</option>
              <option value="TEMPORARY">Temporary</option>
            </Select>
          </Field>
          <div className="flex items-end">
            <Button type="submit" loading={saving} className="w-full">
              Add
            </Button>
          </div>
          {error && (
            <div className="sm:col-span-2 lg:col-span-5">
              <Alert>{error}</Alert>
            </div>
          )}
        </form>
      )}
      <Table>
        <thead className="bg-slate-50 dark:bg-slate-900/50">
          <tr>
            <Th>Entry</Th>
            <Th>Kind</Th>
            <Th>Live until ledger</Th>
            <Th>Remaining</Th>
            <Th />
            <Th>Checked</Th>
            <Th />
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
          {contract.storageEntries.map((s) => (
            <StorageRow key={s.id} contract={contract} entry={s} onChange={onChange} />
          ))}
        </tbody>
      </Table>
    </Card>
  );
}

function StorageRow({
  contract,
  entry,
  onChange,
}: {
  contract: ContractDetail;
  entry: StorageEntry;
  onChange: () => void;
}) {
  const soon = needsExtending(entry);
  const [open, setOpen] = useState(soon);
  return (
    <>
      <tr data-testid="storage-row">
        <Td className="font-medium">{entry.label}</Td>
        <Td>
          <Badge>{entry.kind.toLowerCase()}</Badge>
        </Td>
        <Td className="tabular-nums">
          {entry.exists ? (
            (entry.liveUntilLedger?.toLocaleString() ?? '—')
          ) : (
            <Badge tone="red">missing / archived</Badge>
          )}
        </Td>
        <Td className="whitespace-nowrap">
          {entry.exists ? formatLedgers(entry.ledgersRemaining) : '—'}
        </Td>
        <Td>
          <TtlBar ledgersRemaining={entry.exists ? entry.ledgersRemaining : 0} />
        </Td>
        <Td className="whitespace-nowrap text-xs text-slate-500 dark:text-slate-400">
          {timeAgo(entry.lastCheckedAt)}
        </Td>
        <Td className="whitespace-nowrap">
          {entry.exists && entry.extend && (
            <button
              type="button"
              className={
                soon
                  ? 'mr-3 text-xs font-medium text-amber-700 hover:underline dark:text-amber-400'
                  : 'mr-3 text-xs text-slate-500 dark:text-slate-400 hover:underline'
              }
              aria-expanded={open}
              onClick={() => setOpen((o) => !o)}
            >
              Extend TTL
            </button>
          )}
          {(entry.kind === 'PERSISTENT' || entry.kind === 'TEMPORARY') && (
            <button
              type="button"
              className="text-xs text-rose-600 hover:underline"
              onClick={async () => {
                await api(`/contracts/${contract.id}/storage-entries/${entry.id}`, {
                  method: 'DELETE',
                });
                onChange();
              }}
            >
              Remove
            </button>
          )}
        </Td>
      </tr>
      {open && entry.exists && entry.extend && (
        <tr>
          <Td colSpan={7} className="bg-slate-50/60 dark:bg-slate-900/40">
            <ExtendCommand contract={contract} entry={entry} />
          </Td>
        </tr>
      )}
    </>
  );
}
