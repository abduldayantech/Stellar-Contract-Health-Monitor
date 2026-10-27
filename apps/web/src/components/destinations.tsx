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
  Mono,
  Select,
  Spinner,
} from '@stellar-health/ui';
import { api, errorMessage } from '@/lib/api';
import type { Destination, DestinationType } from '@/lib/types';
import { CopyButton } from './copy-button';

export function DestinationsCard({
  destinations,
  loading,
  onChange,
}: {
  destinations?: Destination[];
  loading: boolean;
  onChange: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [type, setType] = useState<DestinationType>('WEBHOOK');
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [emails, setEmails] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [revealed, setRevealed] = useState<{ id: string; secret: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const config =
        type === 'WEBHOOK'
          ? { url }
          : type === 'SLACK'
            ? { webhookUrl: url }
            : {
                to: emails
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean),
              };
      const body = { type, name, config };
      const d = await api<Destination>('/destinations', { method: 'POST', body });
      if (d.config.secret) setRevealed({ id: d.id, secret: d.config.secret });
      setName('');
      setUrl('');
      setEmails('');
      setAdding(false);
      onChange();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function action(fn: () => Promise<unknown>, success?: string) {
    setError(null);
    setNotice(null);
    try {
      await fn();
      if (success) setNotice(success);
      onChange();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <Card>
      <CardHeader
        title="Notification destinations"
        description="Webhooks receive a signed JSON POST for every alert. Slack posts a formatted message to a channel. Email requires SMTP to be configured on the server."
        actions={
          <Button size="sm" variant="secondary" onClick={() => setAdding((a) => !a)}>
            {adding ? 'Cancel' : 'Add destination'}
          </Button>
        }
      />
      {adding && (
        <form
          onSubmit={submit}
          className="grid gap-3 border-b border-slate-200 p-4 sm:grid-cols-4 dark:border-slate-800"
          aria-label="New destination"
        >
          <Field label="Type" htmlFor="d-type">
            <Select
              id="d-type"
              value={type}
              onChange={(e) => setType(e.target.value as DestinationType)}
            >
              <option value="WEBHOOK">Webhook</option>
              <option value="EMAIL">Email</option>
              <option value="SLACK">Slack</option>
            </Select>
          </Field>
          <Field label="Name" htmlFor="d-name">
            <Input
              id="d-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              placeholder="Ops alerts"
            />
          </Field>
          {type === 'SLACK' ? (
            <Field label="Slack webhook URL" htmlFor="d-url">
              <Input
                id="d-url"
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                required
                placeholder="https://hooks.slack.com/services/…"
              />
            </Field>
          ) : type === 'WEBHOOK' ? (
            <Field label="URL" htmlFor="d-url">
              <Input
                id="d-url"
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                required
                placeholder="https://example.com/hooks/stellar"
              />
            </Field>
          ) : (
            <Field label="Recipients" htmlFor="d-emails" hint="Comma-separated">
              <Input
                id="d-emails"
                value={emails}
                onChange={(e) => setEmails(e.target.value)}
                required
                placeholder="ops@example.com"
              />
            </Field>
          )}
          <div className="flex items-end">
            <Button type="submit" loading={saving} className="w-full">
              Add
            </Button>
          </div>
        </form>
      )}
      <div className="space-y-2 px-4 pt-3 empty:hidden">
        {error && <Alert>{error}</Alert>}
        {notice && <Alert tone="green">{notice}</Alert>}
        {revealed && (
          <Alert tone="yellow" title="Signing secret — copy it now, it won't be shown again">
            <span className="flex flex-wrap items-center gap-2">
              <Mono className="break-all">{revealed.secret}</Mono>{' '}
              <CopyButton value={revealed.secret} />
              <button className="text-xs underline" onClick={() => setRevealed(null)}>
                Done
              </button>
            </span>
          </Alert>
        )}
      </div>
      {loading ? (
        <div className="p-4">
          <Spinner />
        </div>
      ) : !destinations?.length ? (
        <EmptyState
          title="No destinations"
          description="Add a Slack channel, an email address or a webhook URL to receive alerts."
        />
      ) : (
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {destinations.map((d) => (
            <li
              key={d.id}
              className="flex flex-wrap items-center gap-3 px-4 py-3"
              data-testid="destination-row"
            >
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 text-sm font-medium">
                  {d.name} <Badge>{d.type.toLowerCase()}</Badge>{' '}
                  {!d.enabled && <Badge tone="slate">disabled</Badge>}
                </p>
                <p className="truncate text-xs text-slate-500">
                  {d.type === 'WEBHOOK'
                    ? d.config.url
                    : d.type === 'EMAIL'
                      ? d.config.to?.join(', ')
                      : d.config.webhookUrl}
                  {d.config.secret && <> · secret {d.config.secret}</>}
                </p>
                {d.last7Days && Object.keys(d.last7Days).length > 0 && (
                  <p className="text-xs text-slate-500">
                    Last 7 days: {d.last7Days.SUCCEEDED ?? 0} delivered, {d.last7Days.FAILED ?? 0}{' '}
                    failed, {d.last7Days.PENDING ?? 0} pending
                  </p>
                )}
              </div>
              <div className="flex flex-wrap gap-1">
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() =>
                    action(
                      () => api(`/destinations/${d.id}/test`, { method: 'POST' }),
                      `Test notification queued for ${d.name}. Check Alert history → deliveries, or your receiver.`,
                    )
                  }
                >
                  Send test
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    action(() =>
                      api(`/destinations/${d.id}`, {
                        method: 'PATCH',
                        body: { enabled: !d.enabled },
                      }),
                    )
                  }
                >
                  {d.enabled ? 'Disable' : 'Enable'}
                </Button>
                {d.type === 'WEBHOOK' && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      action(async () => {
                        const r = await api<Destination>(`/destinations/${d.id}/rotate-secret`, {
                          method: 'POST',
                        });
                        if (r.config.secret) setRevealed({ id: d.id, secret: r.config.secret });
                      })
                    }
                  >
                    Rotate secret
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-rose-600"
                  onClick={() => action(() => api(`/destinations/${d.id}`, { method: 'DELETE' }))}
                >
                  Delete
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
