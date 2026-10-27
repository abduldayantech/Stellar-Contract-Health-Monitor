'use client';

import { useState, type FormEvent } from 'react';
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
  formatDateTime,
} from '@stellar-health/ui';
import { api, errorMessage, useApi } from '@/lib/api';
import type { AlertRule, Contract, Silence } from '@/lib/types';

function localDateTime(date: Date) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

export function SilencesPanel({
  contracts,
  rules,
  fixedContractRefId,
  buttonLabel = 'New silence',
}: {
  contracts: Contract[];
  rules: AlertRule[];
  fixedContractRefId?: string;
  buttonLabel?: string;
}) {
  const silences = useApi<{ items: Silence[] }>(
    `/silences${fixedContractRefId ? `?contractRefId=${fixedContractRefId}` : ''}`,
  );
  const [adding, setAdding] = useState(false);
  const [contractRefId, setContractRefId] = useState(fixedContractRefId ?? '');
  const [ruleId, setRuleId] = useState('');
  const [startsAt, setStartsAt] = useState(() => localDateTime(new Date()));
  const [endsAt, setEndsAt] = useState(() => localDateTime(new Date(Date.now() + 3_600_000)));
  const [recurrence, setRecurrence] = useState<'NONE' | 'DAILY' | 'WEEKLY'>('NONE');
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy('create');
    try {
      await api('/silences', {
        method: 'POST',
        body: {
          contractRefId: contractRefId || null,
          ruleId: ruleId || null,
          startsAt: new Date(startsAt).toISOString(),
          endsAt: new Date(endsAt).toISOString(),
          recurrence: recurrence === 'NONE' ? null : recurrence,
          timeZone,
          reason,
        },
      });
      setReason('');
      setAdding(false);
      await silences.mutate();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function remove(id: string) {
    setError(null);
    setBusy(id);
    try {
      await api(`/silences/${id}`, { method: 'DELETE' });
      await silences.mutate();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  const availableContracts = fixedContractRefId
    ? contracts.filter((contract) => contract.id === fixedContractRefId)
    : contracts;
  const missingScope = !fixedContractRefId && !contractRefId && !ruleId;
  const scopeDescription = (silence: Silence) =>
    [
      silence.contract
        ? `Contract: ${silence.contract.label ?? silence.contract.contractId.slice(0, 10)}`
        : null,
      silence.rule ? `Rule: ${silence.rule.name}` : null,
    ]
      .filter(Boolean)
      .join(' · ');

  return (
    <Card>
      <CardHeader
        title="Silences"
        description="Alerts are still recorded during a silence, but notifications are skipped."
        actions={
          <Button size="sm" variant="secondary" onClick={() => setAdding((value) => !value)}>
            {adding ? 'Cancel' : buttonLabel}
          </Button>
        }
      />
      {adding && (
        <form
          onSubmit={submit}
          className="grid gap-3 border-b border-slate-200 px-4 py-3 sm:grid-cols-2 dark:border-slate-800"
        >
          {!fixedContractRefId && (
            <Field label="Contract scope" htmlFor="silence-contract">
              <Select
                id="silence-contract"
                value={contractRefId}
                onChange={(event) => setContractRefId(event.target.value)}
              >
                <option value="">All contracts</option>
                {availableContracts.map((contract) => (
                  <option key={contract.id} value={contract.id}>
                    {contract.label ?? contract.contractId.slice(0, 10)}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {fixedContractRefId && (
            <p className="self-end text-sm text-slate-600 dark:text-slate-400">
              Contract:{' '}
              {contracts.find((contract) => contract.id === fixedContractRefId)?.label ??
                contracts
                  .find((contract) => contract.id === fixedContractRefId)
                  ?.contractId.slice(0, 10) ??
                fixedContractRefId}
            </p>
          )}
          <Field label="Rule scope" htmlFor="silence-rule">
            <Select
              id="silence-rule"
              value={ruleId}
              onChange={(event) => setRuleId(event.target.value)}
            >
              <option value="">All rules</option>
              {rules.map((rule) => (
                <option key={rule.id} value={rule.id}>
                  {rule.name}
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
              required
            />
          </Field>
          <Field label="Ends at" htmlFor="silence-end">
            <Input
              id="silence-end"
              type="datetime-local"
              value={endsAt}
              onChange={(event) => setEndsAt(event.target.value)}
              required
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
          <p className="self-end text-sm text-slate-600 dark:text-slate-400">
            Times repeat in {timeZone}
          </p>
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
              type="submit"
              loading={busy === 'create'}
              disabled={missingScope}
              className="w-full"
            >
              Create silence
            </Button>
          </div>
          {missingScope && (
            <p className="text-xs text-rose-600 sm:col-span-2">
              Choose a contract, a rule, or both to scope this silence.
            </p>
          )}
          {error && (
            <div className="sm:col-span-2">
              <Alert>{error}</Alert>
            </div>
          )}
        </form>
      )}
      {silences.isLoading ? (
        <div className="p-4">
          <Spinner />
        </div>
      ) : !silences.data?.items.length ? (
        <EmptyState title="No silences scheduled" />
      ) : (
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {silences.data.items.map((silence) => {
            const now = Date.now();
            const state =
              new Date(silence.startsAt).getTime() > now
                ? 'Scheduled'
                : new Date(silence.endsAt).getTime() > now
                  ? 'Active'
                  : 'Expired';
            return (
              <li key={silence.id} className="flex flex-wrap items-start gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{scopeDescription(silence)}</p>
                  {silence.recurrence && (
                    <Badge tone="indigo">{silence.recurrence.toLowerCase()}</Badge>
                  )}
                  <p className="text-xs text-slate-600 dark:text-slate-400">
                    {formatDateTime(silence.startsAt)} – {formatDateTime(silence.endsAt)} · {state}
                    {silence.recurrence && ` · ${silence.timeZone}`}
                  </p>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    {silence.reason} · created by {silence.createdBy}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-rose-600"
                  loading={busy === silence.id}
                  onClick={() => remove(silence.id)}
                >
                  Delete
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      {error && !adding && (
        <div className="px-4 pb-3">
          <Alert>{error}</Alert>
        </div>
      )}
    </Card>
  );
}
