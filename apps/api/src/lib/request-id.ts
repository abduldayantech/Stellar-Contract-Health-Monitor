import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export const REQUEST_ID_HEADER = 'x-request-id';

/** Letters, digits and `._:-`, up to 128 characters: safe to log and echo back. */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Uses the caller's `x-request-id` when it is safe (so IDs from a proxy or client carry through),
 * otherwise generates one.
 */
export function requestIdFor(req: Pick<IncomingMessage, 'headers'>): string {
  const incoming = req.headers[REQUEST_ID_HEADER];
  return typeof incoming === 'string' && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();
}
