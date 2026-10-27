'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { apiBaseUrl, SESSION_COOKIE } from '@/lib/session';

export interface LoginState {
  error?: string;
}

function safeNext(next: unknown): string {
  return typeof next === 'string' && next.startsWith('/') && !next.startsWith('//') ? next : '/';
}

export async function login(_prev: LoginState, form: FormData): Promise<LoginState> {
  const token = String(form.get('token') ?? '').trim();
  if (!token) return { error: 'Enter an API token' };
  let res: Response;
  try {
    res = await fetch(`${apiBaseUrl()}/auth/me`, {
      headers: { authorization: `Bearer ${token}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return { error: 'Could not reach the monitoring API. Is it running?' };
  }
  if (res.status === 401) {
    const body = (await res.json().catch(() => null)) as { error?: { code?: string } } | null;
    return {
      error:
        body?.error?.code === 'TOKEN_EXPIRED'
          ? 'That token has expired. Ask an admin for a new one.'
          : 'That token is invalid or has been revoked',
    };
  }
  if (!res.ok) return { error: `Unexpected response from API (${res.status})` };

  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.SESSION_COOKIE_SECURE === 'true',
    path: '/',
    maxAge: 60 * 60 * 24 * 30,
  });
  redirect(safeNext(form.get('next')));
}
