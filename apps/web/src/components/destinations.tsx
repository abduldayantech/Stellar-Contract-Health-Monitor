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
  const [botToken, setBotToken] = useState('');
  const [chatId, setChatId] = useState('');
  const [routingKey, setRoutingKey] = useState('');
  const [region, setRegion] = useState<'us' | 'eu'>('us');
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
          : type === 'SLACK' || type === 'DISCORD' || type === 'TEAMS'
            ? { webhookUrl: url }
            : type === 'TELEGRAM'
              ? { botToken, chatId }
              : type === 'PAGERDUTY'
                ? { routingKey, region }
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
      setBotToken('');
      setChatId('');
      setRoutingKey('');
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
        description="Webhooks receive a signed JSON POST for every alert. Slack, Discord, Teams and Telegram post a formatted message to a chat. PagerDuty opens an incident and resolves it when the alert resolves. Email requires SMTP to be configured on the server."
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
              <option value="DISCORD">Discord</option>
              <option value="TEAMS">Microsoft Teams</option>
              <option value="TELEGRAM">Telegram</option>
              <option value="PAGERDUTY">PagerDuty</option>
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
          ) : type === 'DISCORD' ? (
            <Field label="Discord webhook URL" htmlFor="d-url">
              <Input
                id="d-url"
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                required
                placeholder="https://discord.com/api/webhooks/…"
              />
            </Field>
          ) : type === 'TEAMS' ? (
            <Field label="Teams webhook URL" htmlFor="d-url">
              <Input
                id="d-url"
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                required
                placeholder="https://….webhook.office.com/… or Workflows URL"
              />
            </Field>
          ) : type === 'TELEGRAM' ? (
            <>
              <Field label="Bot token" htmlFor="d-bot" hint="From @BotFather; stored encrypted">
                <Input
                  id="d-bot"
                  type="password"
                  autoComplete="off"
                  value={botToken}
                  onChange={(e) => setBotToken(e.target.value)}
                  required
                  placeholder="123456789:AA…"
                />
              </Field>
              <Field label="Chat ID" htmlFor="d-chat">
                <Input
                  id="d-chat"
                  value={chatId}
                  onChange={(e) => setChatId(e.target.value)}
                  required
                  placeholder="-1001234567890 or @channel"
                />
              </Field>
            </>
          ) : type === 'PAGERDUTY' ? (
            <>
              <Field
                label="Integration key"
                htmlFor="d-routing"
                hint="Events API v2 key of a PagerDuty service; stored encrypted"
              >
                <Input
                  id="d-routing"
                  type="password"
                  autoComplete="off"
                  value={routingKey}
                  onChange={(e) => setRoutingKey(e.target.value)}
                  required
                  placeholder="32 characters"
                  className="font-mono"
                />
              </Field>
              <Field label="Region" htmlFor="d-region">
                <Select
                  id="d-region"
                  value={region}
                  onChange={(e) => setRegion(e.target.value as 'us' | 'eu')}
                >
                  <option value="us">US (events.pagerduty.com)</option>
                  <option value="eu">EU (events.eu.pagerduty.com)</option>
                </Select>
              </Field>
            </>
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
          description="Add a Slack, Discord, Teams or Telegram chat, a PagerDuty service, an email address or a webhook URL to receive alerts."
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
                <p className="truncate text-xs text-slate-500 dark:text-slate-400">
                  {d.type === 'WEBHOOK'
                    ? d.config.url
                    : d.type === 'EMAIL'
                      ? d.config.to?.join(', ')
                      : d.type === 'TELEGRAM'
                        ? `chat ${d.config.chatId ?? ''}`
                        : d.type === 'PAGERDUTY'
                          ? `Events API v2 · ${(d.config.region ?? 'us').toUpperCase()} region · opens and resolves incidents`
                          : d.config.webhookUrl}
                  {d.config.secret && <> · secret {d.config.secret}</>}
                </p>
                {!d.enabled && d.disabledReason && (
                  <p className="mt-1 text-xs text-rose-600 dark:text-rose-400" role="status">
                    {d.disabledReason}
                  </p>
                )}
                {d.enabled && (d.consecutiveFailures ?? 0) > 0 && (
                  <p className="text-xs text-amber-700 dark:text-amber-400">
                    {d.consecutiveFailures} failed deliver
                    {d.consecutiveFailures === 1 ? 'y' : 'ies'} in a row
                  </p>
                )}
                {d.last7Days && Object.keys(d.last7Days).length > 0 && (
                  <p className="text-xs text-slate-500 dark:text-slate-400">
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
                  {d.enabled ? 'Disable' : d.disabledReason ? 'Re-enable' : 'Enable'}
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
