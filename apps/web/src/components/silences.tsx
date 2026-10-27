'use client';

import { useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  Field,
  Input,
  Select,
  Spinner,
} from '@stellar-health/ui';
import { api, errorMessage } from '@/lib/api';
import type { AlertRule, Contract, Silence } from '@/lib/types';

function localInput(date: Date) {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatInZone(value: string, timeZone: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone,
  }).format(new Date(value));
}

function zonedDate(value: string, timeZone: string) {
  const [date, time] = value.split('T');
  const [year, month, day] = date!.split('-').map(Number);
  const [hour, minute] = time!.split(':').map(Number);
  const local = Date.UTC(year!, month! - 1, day!, hour!, minute!);
  let timestamp = local;
  for (let i = 0; i < 4; i++) {
    const parts = new Intl.DateTimeFormat('en', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(timestamp));
    const get = (type: Intl.DateTimeFormatPartTypes) =>
      Number(parts.find((part) => part.type === type)?.value);
    const represented = Date.UTC(
      get('year'),
      get('month') - 1,
      get('day'),
      get('hour'),
      get('minute'),
    );
    const adjustment = local - represented;
    timestamp += adjustment;
    if (!adjustment) break;
  }
  return new Date(timestamp).toISOString();
}

export function SilencesSection({
  silences,
  contracts,
  rules,
  contractRefId,
  loading,
  onChange,
}: {
  silences: Silence[] | undefined;
  contracts: Contract[];
  rules: AlertRule[];
  contractRefId?: string;
  loading: boolean;
  onChange: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [contract, setContract] = useState(contractRefId ?? '');
  const [rule, setRule] = useState('');
  const [startsAt, setStartsAt] = useState(() => localInput(new Date(Date.now() + 60_000)));
  const [endsAt, setEndsAt] = useState(() => localInput(new Date(Date.now() + 3_660_000)));
  const [recurrence, setRecurrence] = useState<'NONE' | 'DAILY' | 'WEEKLY'>('NONE');
  const [timeZone, setTimeZone] = useState(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  );
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const shownRules = contractRefId
    ? rules.filter((item) => item.contractRefId === contractRefId || !item.contractRefId)
    : rules;

  async function create() {
    setError(null);
    setBusy(true);
    try {
      await api('/silences', {
        method: 'POST',
        body: {
          contractRefId: contract || null,
          ruleId: rule || null,
          startsAt: zonedDate(startsAt, timeZone),
          endsAt: zonedDate(endsAt, timeZone),
          recurrence: recurrence === 'NONE' ? null : recurrence,
          timeZone,
          reason,
        },
      });
      setReason('');
      setAdding(false);
      onChange();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setError(null);
    setRemoving(id);
    try {
      await api(`/silences/${id}`, { method: 'DELETE' });
      onChange();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setRemoving(null);
    }
  }

  return (
    <Card>
      <CardHeader
        title="Silences"
        description="Mute matching alerts during a planned maintenance window."
        actions={
          <Button size="sm" variant="secondary" onClick={() => setAdding((value) => !value)}>
            {adding ? 'Cancel' : contractRefId ? 'Silence for…' : 'New silence'}
          </Button>
        }
      />
      {adding && (
        <div className="grid gap-3 border-b border-slate-200 px-4 py-3 sm:grid-cols-2 dark:border-slate-800">
          {!contractRefId && (
            <Field label="Contract scope" htmlFor="silence-contract">
              <Select
                id="silence-contract"
                value={contract}
                onChange={(event) => setContract(event.target.value)}
              >
                <option value="">All contracts (select a rule)</option>
                {contracts.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label ?? item.contractId}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {contractRefId && (
            <p className="text-sm text-slate-600 dark:text-slate-400">
              Contract:{' '}
              {contracts.find((item) => item.id === contractRefId)?.label ?? contractRefId}
            </p>
          )}
          <Field label="Rule scope (optional)" htmlFor="silence-rule">
            <Select
              id="silence-rule"
              value={rule}
              onChange={(event) => setRule(event.target.value)}
            >
              <option value="">All rules in scope</option>
              {shownRules.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Starts at" htmlFor="silence-start">
            <Input
              id="silence-start"
              type="datetime-local"
              value={startsAt}
              onChange={(event) => setStartsAt(event.target.value)}
            />
          </Field>
          <Field label="Ends at" htmlFor="silence-end">
            <Input
              id="silence-end"
              type="datetime-local"
              value={endsAt}
              onChange={(event) => setEndsAt(event.target.value)}
            />
          </Field>
          <Field label="Repeat" htmlFor="silence-recurrence">
            <Select
              id="silence-recurrence"
              value={recurrence}
              onChange={(event) => setRecurrence(event.target.value as typeof recurrence)}
            >
              <option value="NONE">Does not repeat</option>
              <option value="DAILY">Daily</option>
              <option value="WEEKLY">Weekly</option>
            </Select>
          </Field>
          <Field label="Timezone (IANA)" htmlFor="silence-timezone">
            <Input
              id="silence-timezone"
              value={timeZone}
              onChange={(event) => setTimeZone(event.target.value)}
              required
            />
          </Field>
          <Field label="Reason" htmlFor="silence-reason">
            <Input
              id="silence-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              maxLength={500}
              required
              placeholder="Planned contract upgrade"
            />
          </Field>
          <div className="flex items-end">
            <Button
              className="w-full"
              loading={busy}
              disabled={(!contract && !rule) || !startsAt || !endsAt || !reason.trim() || !timeZone}
              onClick={create}
            >
              Create silence
            </Button>
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400 sm:col-span-2">
            Times repeat in the selected timezone. Recurring windows use the start/end duration
            shown above.
          </p>
        </div>
      )}
      {error && (
        <div className="px-4 pt-3">
          <Alert>{error}</Alert>
        </div>
      )}
      {loading ? (
        <div className="p-4">
          <Spinner />
        </div>
      ) : silences?.length ? (
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {silences.map((silence) => (
            <li key={silence.id} className="flex flex-wrap items-start gap-3 px-4 py-3">
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{silence.reason}</span>
                  {silence.recurrence && (
                    <Badge tone="indigo">{silence.recurrence.toLowerCase()}</Badge>
                  )}
                </div>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  {silence.contract?.label ??
                    (silence.contract ? silence.contract.contractId : 'All contracts')}
                  {silence.rule && ` · ${silence.rule.name}`}
                  {' · '}
                  {formatInZone(silence.startsAt, silence.timeZone)} –{' '}
                  {formatInZone(silence.endsAt, silence.timeZone)} {silence.timeZone}
                </p>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Created by {silence.createdBy}
                </p>
              </div>
              <Button
                size="sm"
                variant="ghost"
                className="text-rose-600"
                loading={removing === silence.id}
                onClick={() => remove(silence.id)}
              >
                Delete
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState
          title="No silences"
          description="Create a silence to mute alerts temporarily."
        />
      )}
    </Card>
  );
}
