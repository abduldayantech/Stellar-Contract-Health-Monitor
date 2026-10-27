'use client';

import useSWR, { type SWRConfiguration } from 'swr';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

/** Calls the API through the same-origin proxy, which attaches the session token. */
export async function api<T = unknown>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const res = await fetch(`/api/proxy${path}`, {
    method: init.method ?? 'GET',
    headers: init.body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    cache: 'no-store',
  });
  if (res.status === 401) {
    if (typeof window !== 'undefined') {
      window.location.href = `/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`;
    }
    throw new ApiError(401, 'UNAUTHORIZED', 'Session expired');
  }
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string; details?: unknown } } | null)
      ?.error;
    throw new ApiError(
      res.status,
      err?.code ?? 'ERROR',
      err?.message ?? `Request failed (${res.status})`,
      err?.details,
    );
  }
  return data as T;
}

/** Largest page the API serves; used when collecting every page of a list. */
export const MAX_PAGE_SIZE = 500;

/**
 * Follows `nextCursor` until the list is complete and returns it as one page. Used for pickers
 * and fleet-wide counts that need every item.
 */
export async function fetchAllPages<T>(path: string): Promise<{ items: T[]; nextCursor: null }> {
  const [base, query = ''] = path.split('?');
  const params = new URLSearchParams(query);
  params.delete('all');
  params.set('limit', String(MAX_PAGE_SIZE));
  const items: T[] = [];
  for (let cursor: string | null = null, i = 0; i === 0 || cursor; i++) {
    if (cursor) params.set('cursor', cursor);
    const page: { items: T[]; nextCursor?: string | null } = await api(`${base}?${params}`);
    items.push(...page.items);
    cursor = page.nextCursor ?? null;
  }
  return { items, nextCursor: null };
}

/** SWR-backed GET. A path with `all=1` in its query fetches every page of a list. */
export function useApi<T>(path: string | null, config?: SWRConfiguration<T>) {
  return useSWR<T>(
    path,
    (p: string) =>
      new URLSearchParams(p.split('?')[1]).get('all') === '1'
        ? (fetchAllPages(p) as Promise<T>)
        : api<T>(p),
    { revalidateOnFocus: true, ...config },
  );
}

export type Role = 'VIEWER' | 'EDITOR' | 'ADMIN';
export interface Me {
  principal: { type: 'admin' | 'token'; id: string; name: string; role: Role };
}

/** The signed-in principal; used to hide controls the current token may not use. */
export function useMe() {
  return useApi<Me>('/auth/me', { revalidateOnFocus: false });
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return 'Something went wrong';
}

export function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}
