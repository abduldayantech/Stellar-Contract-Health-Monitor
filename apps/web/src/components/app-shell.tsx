'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { cn, StatusDot } from '@stellar-health/ui';
import { useApi, useMe } from '@/lib/api';
import type { Status } from '@/lib/types';
import { ThemeSwitcher } from './theme-switcher';

const NAV = [
  { href: '/', label: 'Overview', match: (p: string) => p === '/' },
  { href: '/contracts/new', label: 'Add contract', match: (p: string) => p === '/contracts/new' },
  { href: '/events', label: 'Events', match: (p: string) => p.startsWith('/events') },
  {
    href: '/alerts/rules',
    label: 'Alert rules',
    match: (p: string) => p.startsWith('/alerts/rules'),
  },
  {
    href: '/alerts/history',
    label: 'Alert history',
    match: (p: string) => p.startsWith('/alerts/history'),
  },
  { href: '/settings', label: 'Settings', match: (p: string) => p.startsWith('/settings') },
];

function SignedInAs() {
  const { data } = useMe();
  if (!data) return null;
  return (
    <p
      className="truncate px-2 text-xs text-slate-500 dark:text-slate-400"
      data-testid="signed-in-as"
    >
      {data.principal.name} · {data.principal.role.toLowerCase()}
    </p>
  );
}

function MonitoringStatus() {
  const { data, error } = useApi<Status>('/status', { refreshInterval: 15_000 });
  let tone: 'green' | 'yellow' | 'red' | 'slate' = 'slate';
  let text = 'Checking…';
  if (error) {
    tone = 'red';
    text = 'API unreachable';
  } else if (data) {
    if (!data.database.ok || !data.redis.ok) {
      tone = 'red';
      text = !data.database.ok ? 'Database down' : 'Redis down';
    } else if (!data.workerHealthy) {
      tone = 'red';
      text = 'Worker offline';
    } else if (data.networks.some((n) => n.configured && n.lastError)) {
      tone = 'yellow';
      text = 'RPC issues';
    } else {
      tone = 'green';
      text = 'Monitoring active';
    }
  }
  return (
    <Link
      href="/settings#status"
      className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
      data-testid="monitoring-status"
    >
      <StatusDot tone={tone} pulse={tone === 'green'} label={text} />
      {text}
    </Link>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  if (pathname === '/login') return <>{children}</>;

  const nav = (
    <nav className="flex flex-col gap-0.5" aria-label="Main">
      {NAV.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          onClick={() => setOpen(false)}
          aria-current={item.match(pathname) ? 'page' : undefined}
          className={cn(
            'rounded-md px-3 py-2 text-sm font-medium',
            item.match(pathname)
              ? 'bg-indigo-50 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300'
              : 'text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800',
          )}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );

  return (
    <div className="min-h-screen lg:flex">
      <aside className="hidden w-60 shrink-0 flex-col gap-6 border-r border-slate-200 bg-white px-3 py-5 lg:flex dark:border-slate-800 dark:bg-slate-900">
        <Link href="/" className="flex items-center gap-2 px-3">
          <img src="/icon.svg" alt="" className="h-7 w-7" />
          <span className="text-sm font-semibold leading-tight">
            Stellar Contract
            <br />
            Health Monitor
          </span>
        </Link>
        {nav}
        <div className="mt-auto space-y-1">
          <MonitoringStatus />
          <SignedInAs />
          <ThemeSwitcher className="mx-2 flex" />
          <form action="/logout" method="post">
            <button className="w-full rounded-md px-2 py-1.5 text-left text-xs text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800">
              Sign out
            </button>
          </form>
        </div>
      </aside>

      <header className="sticky top-0 z-20 flex items-center justify-between border-b border-slate-200 bg-white px-4 py-3 lg:hidden dark:border-slate-800 dark:bg-slate-900">
        <Link href="/" className="text-sm font-semibold">
          Stellar Contract Health
        </Link>
        <div className="flex items-center gap-2">
          <MonitoringStatus />
          <button
            type="button"
            className="rounded-md px-2 py-1 text-sm ring-1 ring-slate-300 dark:ring-slate-700"
            aria-expanded={open}
            aria-controls="mobile-nav"
            onClick={() => setOpen((o) => !o)}
          >
            Menu
          </button>
        </div>
      </header>
      {open && (
        <div
          id="mobile-nav"
          className="border-b border-slate-200 bg-white px-3 py-2 lg:hidden dark:border-slate-800 dark:bg-slate-900"
        >
          {nav}
          <ThemeSwitcher className="mx-3 mt-2 flex" />
          <form action="/logout" method="post">
            <button className="mt-1 w-full rounded-md px-3 py-2 text-left text-sm text-slate-500 dark:text-slate-400">
              Sign out
            </button>
          </form>
        </div>
      )}

      <main className="min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-8">{children}</main>
    </div>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">{title}</h1>
        {description && (
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{description}</p>
        )}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
