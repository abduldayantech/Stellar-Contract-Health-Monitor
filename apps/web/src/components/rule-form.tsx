'use client';

import { useState, type FormEvent } from 'react';
import {
  Alert,
  Button,
  Card,
  CardHeader,
  Field,
  Input,
  Select,
  ledgersToDuration,
} from '@stellar-health/ui';
import { api, errorMessage } from '@/lib/api';
import { RULE_TYPE_LABELS } from '@/lib/rules';
import type { AlertRule, Contract, Destination } from '@/lib/types';

type RuleType = AlertRule['type'];

const LEDGERS_PER_DAY = 17_280;
const NAME_MAX = 120;
const COPY_SUFFIX = ' (copy)';

/** Create-mode name for a duplicated rule, kept within the input max length. */
function nameForCopy(name: string): string {
  if (name.length + COPY_SUFFIX.length <= NAME_MAX) return `${name}${COPY_SUFFIX}`;
  return `${name.slice(0, NAME_MAX - COPY_SUFFIX.length).trimEnd()}${COPY_SUFFIX}`;
}

export function RuleForm({
  rule,
  copyFrom = null,
  presetContractRefId,
  contracts,
  destinations,
  onCancel,
  onSaved,
}: {
  rule: AlertRule | null;
  /** Prefills a new rule. Type and contract stay editable. Ignored while editing. */
  copyFrom?: AlertRule | null;
  presetContractRefId?: string;
  contracts: Contract[];
  destinations: Destination[];
  onCancel: () => void;
  onSaved: () => void;
}) {
  const seed = rule ?? copyFrom;
  const copying = !rule && copyFrom != null;
  const cfg = (seed?.config ?? {}) as Record<string, unknown>;
  const [name, setName] = useState(copying ? nameForCopy(seed?.name ?? '') : (seed?.name ?? ''));
  const [type, setType] = useState<RuleType>(seed?.type ?? 'EVENT_MATCH');
  const [contractRefId, setContractRefId] = useState(
    seed ? (seed.contractRefId ?? '') : (presetContractRefId ?? ''),
  );
  const [severity, setSeverity] = useState(seed?.severity ?? 'WARNING');
  const [cooldownMinutes, setCooldownMinutes] = useState(
    String((seed?.cooldownSeconds ?? 300) / 60),
  );
  const [destinationIds, setDestinationIds] = useState<string[]>(
    seed?.destinations.map((d) => d.id) ?? [],
  );
  // EVENT_MATCH
  const [topics, setTopics] = useState(((cfg.topics as string[] | undefined) ?? []).join(', '));
  const [threshold, setThreshold] = useState(String(cfg.threshold ?? 1));
  const [windowMinutes, setWindowMinutes] = useState(String(Number(cfg.windowSeconds ?? 300) / 60));
  // TTL_EXPIRY
  const [ttlDays, setTtlDays] = useState(
    String(Number(cfg.ledgersThreshold ?? LEDGERS_PER_DAY * 7) / LEDGERS_PER_DAY),
  );
  // INACTIVITY
  const [idleHours, setIdleHours] = useState(String(Number(cfg.windowSeconds ?? 86400) / 3600));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function buildConfig() {
    switch (type) {
      case 'EVENT_MATCH':
        return {
          topics: topics
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean),
          threshold: Math.max(1, Math.round(Number(threshold) || 1)),
          windowSeconds: Math.max(1, Math.round(Number(windowMinutes) * 60) || 300),
          includeFailedCalls: false,
        };
      case 'TTL_EXPIRY':
        return { ledgersThreshold: Math.max(1, Math.round(Number(ttlDays) * LEDGERS_PER_DAY)) };
      case 'INACTIVITY':
        return { windowSeconds: Math.max(60, Math.round(Number(idleHours) * 3600)) };
      case 'WASM_CHANGED':
        return {};
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    const common = {
      name: name.trim(),
      severity,
      cooldownSeconds: Math.max(0, Math.round(Number(cooldownMinutes) * 60) || 0),
      destinationIds,
      config: buildConfig(),
    };
    try {
      if (rule) await api(`/alert-rules/${rule.id}`, { method: 'PATCH', body: common });
      else
        await api('/alert-rules', {
          method: 'POST',
          body: { ...common, type, contractRefId: contractRefId || null },
        });
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader title={rule ? `Edit “${rule.name}”` : 'New alert rule'} />
      <form onSubmit={submit} className="space-y-4 p-4" aria-label="Alert rule">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Name" htmlFor="r-name">
            <Input
              id="r-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={120}
              placeholder="Large transfers"
            />
          </Field>
          <Field label="Type" htmlFor="r-type" hint={rule ? 'Type cannot be changed' : undefined}>
            <Select
              id="r-type"
              value={type}
              onChange={(e) => setType(e.target.value as RuleType)}
              disabled={Boolean(rule)}
            >
              {(Object.keys(RULE_TYPE_LABELS) as RuleType[]).map((t) => (
                <option key={t} value={t}>
                  {RULE_TYPE_LABELS[t]}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Contract"
            htmlFor="r-contract"
            hint={rule ? 'Scope cannot be changed' : undefined}
          >
            <Select
              id="r-contract"
              value={contractRefId}
              onChange={(e) => setContractRefId(e.target.value)}
              disabled={Boolean(rule)}
            >
              <option value="">All contracts</option>
              {contracts.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label ?? c.contractId.slice(0, 12)} ({c.network.toLowerCase()})
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Severity" htmlFor="r-sev">
            <Select
              id="r-sev"
              value={severity}
              onChange={(e) => setSeverity(e.target.value as AlertRule['severity'])}
            >
              <option value="INFO">Info</option>
              <option value="WARNING">Warning</option>
              <option value="CRITICAL">Critical</option>
            </Select>
          </Field>
        </div>

        <fieldset className="rounded-md border border-slate-200 p-3 dark:border-slate-800">
          <legend className="px-1 text-xs font-medium text-slate-600 dark:text-slate-300">
            Condition
          </legend>
          {type === 'EVENT_MATCH' && (
            <div className="grid gap-4 sm:grid-cols-3">
              <Field
                label="Topics"
                htmlFor="r-topics"
                hint='Comma-separated, matched by position. "*" matches anything. Empty = any event.'
              >
                <Input
                  id="r-topics"
                  value={topics}
                  onChange={(e) => setTopics(e.target.value)}
                  placeholder="transfer, *, GABC…"
                />
              </Field>
              <Field
                label="Threshold (events)"
                htmlFor="r-threshold"
                hint="Trigger when at least this many match…"
              >
                <Input
                  id="r-threshold"
                  type="number"
                  min={1}
                  value={threshold}
                  onChange={(e) => setThreshold(e.target.value)}
                />
              </Field>
              <Field label="Window (minutes)" htmlFor="r-window" hint="…within this time window.">
                <Input
                  id="r-window"
                  type="number"
                  min={1}
                  step="any"
                  value={windowMinutes}
                  onChange={(e) => setWindowMinutes(e.target.value)}
                />
              </Field>
            </div>
          )}
          {type === 'TTL_EXPIRY' && (
            <div className="grid gap-4 sm:grid-cols-3">
              <Field
                label="Alert when TTL is below (days)"
                htmlFor="r-ttl"
                hint={`= ${Math.round(Number(ttlDays) * LEDGERS_PER_DAY).toLocaleString()} ledgers (~${ledgersToDuration(Math.round(Number(ttlDays) * LEDGERS_PER_DAY))})`}
              >
                <Input
                  id="r-ttl"
                  type="number"
                  min={0.01}
                  step="any"
                  value={ttlDays}
                  onChange={(e) => setTtlDays(e.target.value)}
                />
              </Field>
              <p className="text-xs text-slate-500 sm:col-span-2 sm:self-center">
                Applies to the contract instance, its WASM code and any storage entries you add on
                the contract page. Already-expired entries escalate to critical.
              </p>
            </div>
          )}
          {type === 'WASM_CHANGED' && (
            <p className="text-xs text-slate-500">
              Checked with every storage TTL check (every few minutes). Triggers once per upgrade,
              with the old and new WASM hashes. Set the severity to critical if upgrades should page
              someone.
            </p>
          )}
          {type === 'INACTIVITY' && (
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="No events for (hours)" htmlFor="r-idle">
                <Input
                  id="r-idle"
                  type="number"
                  min={0.02}
                  step="any"
                  value={idleHours}
                  onChange={(e) => setIdleHours(e.target.value)}
                />
              </Field>
              <p className="text-xs text-slate-500 sm:col-span-2 sm:self-center">
                The alert resolves automatically when the contract emits events again.
              </p>
            </div>
          )}
        </fieldset>

        <div className="grid gap-4 sm:grid-cols-3">
          <Field
            label="Cooldown (minutes)"
            htmlFor="r-cooldown"
            hint="Minimum time between alerts for this rule and contract."
          >
            <Input
              id="r-cooldown"
              type="number"
              min={0}
              step="any"
              value={cooldownMinutes}
              onChange={(e) => setCooldownMinutes(e.target.value)}
            />
          </Field>
          <div className="sm:col-span-2">
            <p className="mb-1 text-xs font-medium text-slate-700 dark:text-slate-300">Notify</p>
            {destinations.length === 0 ? (
              <p className="text-xs text-slate-500">
                No destinations yet — add a webhook below. Alerts are still recorded in history.
              </p>
            ) : (
              <div className="flex flex-wrap gap-3">
                {destinations.map((d) => (
                  <label key={d.id} className="flex items-center gap-1.5 text-sm">
                    <input
                      type="checkbox"
                      className="rounded border-slate-300"
                      checked={destinationIds.includes(d.id)}
                      onChange={(e) =>
                        setDestinationIds((ids) =>
                          e.target.checked ? [...ids, d.id] : ids.filter((i) => i !== d.id),
                        )
                      }
                    />
                    {d.name}{' '}
                    <span className="text-xs text-slate-500">({d.type.toLowerCase()})</span>
                  </label>
                ))}
              </div>
            )}
          </div>
        </div>

        {error && <Alert>{error}</Alert>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" loading={saving}>
            {rule ? 'Save changes' : 'Create rule'}
          </Button>
        </div>
      </form>
    </Card>
  );
}
