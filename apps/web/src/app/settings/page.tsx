'use client';

import { useEffect, useState, type FormEvent } from 'react';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  Field,
  Input,
  Mono,
  Select,
  Spinner,
  StatusDot,
  Table,
  Td,
  Th,
  timeAgo,
} from '@stellar-health/ui';
import { PageHeader } from '@/components/app-shell';
import { CopyButton } from '@/components/copy-button';
import { api, errorMessage, useApi, useMe, type Role } from '@/lib/api';
import { EXPIRY_OPTIONS, tokenExpiry } from '@/lib/token-expiry';
import type { Destination, Network, Page, Status } from '@/lib/types';

interface NetworkSetting {
  network: Network;
  rpcUrl: string;
  networkPassphrase: string;
  enabled: boolean;
  source: 'database' | 'environment' | 'default' | 'unconfigured';
  defaultRpcUrl: string | null;
  state: {
    latestLedger: number | null;
    lastCheckedAt: string | null;
    lastError: string | null;
  } | null;
}

interface Token {
  id: string;
  name: string;
  role: Role;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  expiresAt: string | null;
}

interface AuditEntry {
  id: string;
  createdAt: string;
  actorName: string;
  method: string;
  route: string;
  path: string;
  statusCode: number;
  ip: string | null;
}

const ROLE_HELP: Record<Role, string> = {
  VIEWER: 'Read-only access',
  EDITOR: 'Manage contracts, rules, destinations and alerts',
  ADMIN: 'Everything, including settings, tokens and the audit log',
};

interface Prefs {
  defaultCooldownSeconds: number;
  defaultDestinationIds: string[];
  notifyOnResolve: boolean;
}

export default function SettingsPage() {
  const me = useMe();
  const role = me.data?.principal.role;
  return (
    <div className="space-y-6">
      <PageHeader
        title="Settings"
        description="RPC providers, API access and notification preferences."
      />
      {role && role !== 'ADMIN' && (
        <Alert tone="blue" title={`Signed in with a ${role.toLowerCase()} token`}>
          Changing settings and managing API tokens requires an admin token.
        </Alert>
      )}
      <RpcProviders />
      {role === 'ADMIN' && <ApiTokens />}
      <NotificationPreferences />
      {role === 'ADMIN' && <AuditLog />}
      <SystemStatus />
    </div>
  );
}

function AuditLog() {
  const { data, isLoading } = useApi<Page<AuditEntry>>('/audit-log?limit=25', {
    refreshInterval: 30_000,
  });
  return (
    <Card>
      <CardHeader
        title="Audit log"
        description="Every change made through the API or dashboard, including denied attempts."
      />
      {isLoading ? (
        <div className="p-4">
          <Spinner />
        </div>
      ) : !data?.items.length ? (
        <EmptyState title="No changes recorded yet" />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>When</Th>
              <Th>Who</Th>
              <Th>Action</Th>
              <Th>Result</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {data.items.map((a) => (
              <tr key={a.id} data-testid="audit-row">
                <Td className="whitespace-nowrap">{timeAgo(a.createdAt)}</Td>
                <Td>{a.actorName}</Td>
                <Td>
                  <Mono className="break-all">
                    {a.method} {a.path}
                  </Mono>
                </Td>
                <Td>
                  <Badge
                    tone={a.statusCode < 400 ? 'green' : a.statusCode === 403 ? 'yellow' : 'red'}
                  >
                    {a.statusCode}
                  </Badge>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

function RpcProviders() {
  const { data, mutate, isLoading } = useApi<{ items: NetworkSetting[] }>('/settings/networks');
  return (
    <Card>
      <CardHeader
        title="RPC providers"
        description="Stellar RPC endpoint used for each network. Changes apply to the worker within 30 seconds."
      />
      {isLoading || !data ? (
        <div className="p-4">
          <Spinner />
        </div>
      ) : (
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {data.items.map((n) => (
            <NetworkRow key={n.network} setting={n} onSaved={() => mutate()} />
          ))}
        </ul>
      )}
    </Card>
  );
}

function NetworkRow({ setting, onSaved }: { setting: NetworkSetting; onSaved: () => void }) {
  const [url, setUrl] = useState(setting.rpcUrl);
  const [busy, setBusy] = useState<'test' | 'save' | 'reset' | null>(null);
  const [result, setResult] = useState<{ tone: 'green' | 'red'; text: string } | null>(null);
  useEffect(() => setUrl(setting.rpcUrl), [setting.rpcUrl]);

  async function test() {
    setBusy('test');
    setResult(null);
    try {
      const r = await api<{
        ok: boolean;
        error?: string;
        latestLedger?: number;
        passphrase?: string;
        latencyMs?: number;
      }>('/settings/networks/test', {
        method: 'POST',
        body: { rpcUrl: url },
      });
      setResult(
        r.ok
          ? {
              tone: r.passphrase === setting.networkPassphrase ? 'green' : 'red',
              text: `${r.passphrase === setting.networkPassphrase ? 'Reachable' : 'Wrong network'}: ledger ${r.latestLedger?.toLocaleString()} · ${r.latencyMs} ms · “${r.passphrase}”`,
            }
          : { tone: 'red', text: r.error ?? 'Unreachable' },
      );
    } catch (err) {
      setResult({ tone: 'red', text: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy('save');
    setResult(null);
    try {
      await api(`/settings/networks/${setting.network}`, { method: 'PUT', body: { rpcUrl: url } });
      setResult({ tone: 'green', text: 'Saved' });
      onSaved();
    } catch (err) {
      setResult({ tone: 'red', text: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  }

  async function reset() {
    setBusy('reset');
    try {
      await api(`/settings/networks/${setting.network}`, { method: 'DELETE' });
      onSaved();
      setResult(null);
    } finally {
      setBusy(null);
    }
  }

  return (
    <li className="px-4 py-3">
      <form
        onSubmit={save}
        className="flex flex-wrap items-end gap-3"
        aria-label={`${setting.network} RPC`}
      >
        <div className="w-28">
          <p className="text-sm font-medium">
            {setting.network.charAt(0) + setting.network.slice(1).toLowerCase()}
          </p>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {setting.source === 'unconfigured' ? 'not configured' : `from ${setting.source}`}
          </p>
        </div>
        <div className="min-w-64 flex-1">
          <Field
            label={<span className="sr-only">{setting.network} RPC URL</span>}
            htmlFor={`rpc-${setting.network}`}
          >
            <Input
              id={`rpc-${setting.network}`}
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://…"
              className="font-mono"
            />
          </Field>
        </div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={test}
          loading={busy === 'test'}
          disabled={!url}
        >
          Test
        </Button>
        <Button
          type="submit"
          size="sm"
          loading={busy === 'save'}
          disabled={!url || url === setting.rpcUrl}
        >
          Save
        </Button>
        {setting.source === 'database' && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={reset}
            loading={busy === 'reset'}
          >
            Reset
          </Button>
        )}
      </form>
      {result && (
        <p
          className={`mt-1 text-xs ${result.tone === 'green' ? 'text-emerald-600' : 'text-rose-600'}`}
        >
          {result.text}
        </p>
      )}
      {setting.state?.lastError && (
        <p className="mt-1 text-xs text-rose-600">Last error: {setting.state.lastError}</p>
      )}
    </li>
  );
}

function ApiTokens() {
  const { data, mutate } = useApi<Page<Token>>('/settings/tokens');
  const [name, setName] = useState('');
  const [role, setRole] = useState<Role>('VIEWER');
  const [expiresIn, setExpiresIn] = useState<string>('90');
  const [created, setCreated] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function create(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const r = await api<{ token: string }>('/settings/tokens', {
        method: 'POST',
        body: { name, role, expiresInDays: expiresIn ? Number(expiresIn) : null },
      });
      setCreated(r.token);
      setName('');
      await mutate();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader
        title="API tokens"
        description="Tokens authenticate the dashboard and API clients (Authorization: Bearer <token>). Only a hash is stored."
      />
      <form
        onSubmit={create}
        className="flex flex-wrap items-end gap-3 border-b border-slate-200 px-4 py-3 dark:border-slate-800"
      >
        <div className="min-w-56 flex-1">
          <Field label="New token name" htmlFor="token-name">
            <Input
              id="token-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              placeholder="CI pipeline"
              maxLength={120}
            />
          </Field>
        </div>
        <div className="w-44">
          <Field label="Role" htmlFor="token-role">
            <Select
              id="token-role"
              value={role}
              onChange={(e) => setRole(e.target.value as Role)}
              title={ROLE_HELP[role]}
            >
              <option value="VIEWER">Viewer</option>
              <option value="EDITOR">Editor</option>
              <option value="ADMIN">Admin</option>
            </Select>
          </Field>
        </div>
        <div className="w-36">
          <Field label="Expires" htmlFor="token-expiry">
            <Select
              id="token-expiry"
              value={expiresIn}
              onChange={(e) => setExpiresIn(e.target.value)}
            >
              {EXPIRY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Button type="submit" loading={saving}>
          Create token
        </Button>
        <p className="basis-full text-xs text-slate-500 dark:text-slate-400">{ROLE_HELP[role]}.</p>
      </form>
      <div className="space-y-2 px-4 pt-3 empty:hidden">
        {error && <Alert>{error}</Alert>}
        {created && (
          <Alert tone="yellow" title="Copy your new token now — it won't be shown again">
            <span className="flex flex-wrap items-center gap-2">
              <Mono className="break-all">{created}</Mono>
              <CopyButton value={created} />
              <button className="text-xs underline" onClick={() => setCreated(null)}>
                Done
              </button>
            </span>
          </Alert>
        )}
      </div>
      {!data?.items.length ? (
        <EmptyState
          title="No API tokens"
          description="You are signed in with the bootstrap admin token. Create named tokens for people and integrations."
        />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Name</Th>
              <Th>Role</Th>
              <Th>Token</Th>
              <Th>Created</Th>
              <Th>Last used</Th>
              <Th>Expires</Th>
              <Th />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {data.items.map((t) => (
              <tr key={t.id}>
                <Td className="font-medium">{t.name}</Td>
                <Td>
                  <Badge tone={t.role === 'ADMIN' ? 'indigo' : 'slate'}>
                    {t.role.toLowerCase()}
                  </Badge>
                </Td>
                <Td>
                  <Mono>{t.prefix}…</Mono>
                </Td>
                <Td>{timeAgo(t.createdAt)}</Td>
                <Td>{timeAgo(t.lastUsedAt)}</Td>
                <Td>
                  <TokenExpiryBadge token={t} />
                </Td>
                <Td>
                  {t.revokedAt ? (
                    <Badge tone="slate">revoked</Badge>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-rose-600"
                      onClick={async () => {
                        try {
                          await api(`/settings/tokens/${t.id}`, { method: 'DELETE' });
                          await mutate();
                        } catch (err) {
                          setError(errorMessage(err));
                        }
                      }}
                    >
                      Revoke
                    </Button>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

function TokenExpiryBadge({ token }: { token: Token }) {
  if (token.revokedAt) return <span className="text-slate-400">—</span>;
  const e = tokenExpiry(token.expiresAt);
  const title = token.expiresAt ? new Date(token.expiresAt).toLocaleString() : undefined;
  return e.soon ? (
    <Badge tone={e.tone}>
      <span title={title}>{e.label}</span>
    </Badge>
  ) : (
    <span title={title}>{e.label}</span>
  );
}

function NotificationPreferences() {
  const prefs = useApi<Prefs>('/settings/notifications');
  const destinations = useApi<Page<Destination>>('/destinations');
  const [draft, setDraft] = useState<Prefs | null>(null);
  const [msg, setMsg] = useState<{ tone: 'green' | 'red'; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (prefs.data) setDraft(prefs.data);
  }, [prefs.data]);

  if (!draft) {
    return (
      <Card className="p-4">
        <Spinner />
      </Card>
    );
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setMsg(null);
    try {
      await api('/settings/notifications', { method: 'PUT', body: draft });
      await prefs.mutate();
      setMsg({ tone: 'green', text: 'Preferences saved' });
    } catch (err) {
      setMsg({ tone: 'red', text: errorMessage(err) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader title="Notification preferences" />
      <form onSubmit={save} className="space-y-4 p-4">
        <div>
          <p className="text-xs font-medium text-slate-700 dark:text-slate-300">
            Default destinations
          </p>
          <p className="mb-2 text-xs text-slate-500 dark:text-slate-400">
            Used by rules that don&apos;t select any destinations of their own.
          </p>
          {destinations.data?.items.length ? (
            <div className="flex flex-wrap gap-3">
              {destinations.data.items.map((d) => (
                <label key={d.id} className="flex items-center gap-1.5 text-sm">
                  <input
                    type="checkbox"
                    checked={draft.defaultDestinationIds.includes(d.id)}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        defaultDestinationIds: e.target.checked
                          ? [...draft.defaultDestinationIds, d.id]
                          : draft.defaultDestinationIds.filter((i) => i !== d.id),
                      })
                    }
                  />
                  {d.name}
                </label>
              ))}
            </div>
          ) : (
            <p className="text-xs text-slate-500 dark:text-slate-400">
              No destinations configured yet.
            </p>
          )}
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={draft.notifyOnResolve}
            onChange={(e) => setDraft({ ...draft, notifyOnResolve: e.target.checked })}
          />
          Also notify when TTL and inactivity alerts resolve on their own
        </label>
        <div className="max-w-xs">
          <Field label="Default cooldown for new rules (minutes)" htmlFor="pref-cooldown">
            <Input
              id="pref-cooldown"
              type="number"
              min={0}
              value={draft.defaultCooldownSeconds / 60}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  defaultCooldownSeconds: Math.max(0, Math.round(Number(e.target.value) * 60)),
                })
              }
            />
          </Field>
        </div>
        {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
        <Button type="submit" loading={saving}>
          Save preferences
        </Button>
      </form>
    </Card>
  );
}

function SystemStatus() {
  const { data } = useApi<Status>('/status', { refreshInterval: 10_000 });
  return (
    <Card id="status">
      <CardHeader title="System status" description="Health of the monitoring pipeline." />
      {!data ? (
        <div className="p-4">
          <Spinner />
        </div>
      ) : (
        <div className="grid gap-4 p-4 text-sm md:grid-cols-2">
          <ul className="space-y-2">
            <li className="flex items-center gap-2">
              <StatusDot tone={data.database.ok ? 'green' : 'red'} /> Database{' '}
              <span className="ml-auto text-xs text-slate-500 dark:text-slate-400">
                {data.database.ok ? `${data.database.latencyMs} ms` : data.database.error}
              </span>
            </li>
            <li className="flex items-center gap-2">
              <StatusDot tone={data.redis.ok ? 'green' : 'red'} /> Redis{' '}
              <span className="ml-auto text-xs text-slate-500 dark:text-slate-400">
                {data.redis.ok ? `${data.redis.latencyMs} ms` : data.redis.error}
              </span>
            </li>
            {data.workers.length === 0 && (
              <li className="flex items-center gap-2">
                <StatusDot tone="red" /> No worker has reported in
              </li>
            )}
            {data.workers.map((w) => (
              <li key={w.name} className="flex items-center gap-2">
                <StatusDot tone={w.healthy ? 'green' : 'red'} /> Worker <Mono>{w.name}</Mono>
                <span className="ml-auto text-xs text-slate-500 dark:text-slate-400">
                  last beat {timeAgo(w.lastBeatAt)}
                </span>
              </li>
            ))}
          </ul>
          {data.queues && (
            <Table>
              <thead>
                <tr>
                  <Th>Queue</Th>
                  <Th>Waiting</Th>
                  <Th>Active</Th>
                  <Th>Delayed</Th>
                  <Th>Failed</Th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(data.queues).map(([q, c]) => (
                  <tr key={q}>
                    <Td>{q}</Td>
                    <Td>{c.waiting ?? 0}</Td>
                    <Td>{c.active ?? 0}</Td>
                    <Td>{c.delayed ?? 0}</Td>
                    <Td className={c.failed ? 'text-rose-600' : undefined}>{c.failed ?? 0}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </div>
      )}
    </Card>
  );
}
