'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  Spinner,
  SeverityBadge,
  formatDuration,
} from '@stellar-health/ui';
import { PageHeader } from '@/components/app-shell';
import { DestinationsCard } from '@/components/destinations';
import { RuleForm } from '@/components/rule-form';
import { api, errorMessage, useApi } from '@/lib/api';
import { describeRule, RULE_TYPE_LABELS } from '@/lib/rules';
import type { AlertRule, Contract, Destination, Page } from '@/lib/types';

function RulesPage() {
  const params = useSearchParams();
  const presetContract = params.get('contractRefId') ?? '';
  const rules = useApi<Page<AlertRule>>('/alert-rules');
  const contracts = useApi<Page<Contract>>('/contracts?limit=500');
  const destinations = useApi<Page<Destination>>('/destinations');
  const [showForm, setShowForm] = useState(Boolean(presetContract));
  const [editing, setEditing] = useState<AlertRule | null>(null);
  const [copying, setCopying] = useState<AlertRule | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function toggle(rule: AlertRule) {
    setError(null);
    try {
      await api(`/alert-rules/${rule.id}`, { method: 'PATCH', body: { enabled: !rule.enabled } });
      await rules.mutate();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function remove(rule: AlertRule) {
    setError(null);
    try {
      await api(`/alert-rules/${rule.id}`, { method: 'DELETE' });
      await rules.mutate();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Alert configuration"
        description="Define what should trigger an alert and where notifications are sent."
        actions={
          !showForm && (
            <Button
              onClick={() => {
                setEditing(null);
                setCopying(null);
                setShowForm(true);
              }}
            >
              New rule
            </Button>
          )
        }
      />

      {showForm && (
        <RuleForm
          key={editing?.id ?? (copying ? `copy-${copying.id}` : 'new')}
          rule={editing}
          copyFrom={editing ? null : copying}
          presetContractRefId={presetContract}
          contracts={contracts.data?.items ?? []}
          destinations={destinations.data?.items ?? []}
          onCancel={() => {
            setShowForm(false);
            setEditing(null);
            setCopying(null);
          }}
          onSaved={async () => {
            setShowForm(false);
            setEditing(null);
            setCopying(null);
            await rules.mutate();
          }}
        />
      )}

      {error && <Alert>{error}</Alert>}

      <Card>
        <CardHeader
          title="Rules"
          description="Rules without a contract apply to every monitored contract."
        />
        {rules.isLoading ? (
          <div className="p-4">
            <Spinner />
          </div>
        ) : !rules.data?.items.length ? (
          <EmptyState
            title="No alert rules yet"
            description="Create a rule to be notified about contract events, inactivity or storage that is about to expire."
          />
        ) : (
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {rules.data.items.map((r) => (
              <li
                key={r.id}
                className="flex flex-wrap items-start gap-3 px-4 py-3"
                data-testid="rule-row"
              >
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{r.name}</span>
                    <Badge tone="indigo">{RULE_TYPE_LABELS[r.type]}</Badge>
                    <SeverityBadge severity={r.severity} />
                    {!r.enabled && <Badge tone="slate">disabled</Badge>}
                  </div>
                  <p className="text-xs text-slate-600 dark:text-slate-400">{describeRule(r)}</p>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    {r.contract
                      ? `Contract: ${r.contract.label ?? r.contract.contractId.slice(0, 10)}`
                      : 'All contracts'}{' '}
                    · cooldown {r.cooldownSeconds ? formatDuration(r.cooldownSeconds) : 'none'} ·{' '}
                    {r.destinations.length
                      ? `notifies ${r.destinations.map((d) => d.name).join(', ')}`
                      : 'default destinations'}
                  </p>
                </div>
                <div className="flex items-center gap-1">
                  <Button size="sm" variant="secondary" onClick={() => toggle(r)}>
                    {r.enabled ? 'Disable' : 'Enable'}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setCopying(null);
                      setEditing(r);
                      setShowForm(true);
                      window.scrollTo({ top: 0, behavior: 'smooth' });
                    }}
                  >
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setEditing(null);
                      setCopying(r);
                      setShowForm(true);
                      window.scrollTo({ top: 0, behavior: 'smooth' });
                    }}
                  >
                    Duplicate
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-rose-600"
                    onClick={() => remove(r)}
                  >
                    Delete
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <DestinationsCard
        destinations={destinations.data?.items}
        loading={destinations.isLoading}
        onChange={() => destinations.mutate()}
      />
    </div>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<Spinner />}>
      <RulesPage />
    </Suspense>
  );
}
