import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { requestIdFor } from '../../src/lib/request-id';

const withHeader = (value?: string | string[]) =>
  ({ headers: value === undefined ? {} : { 'x-request-id': value } }) as IncomingMessage;

describe('requestIdFor', () => {
  it('reuses a safe incoming ID', () => {
    expect(requestIdFor(withHeader('abc-123_DEF.4:5'))).toBe('abc-123_DEF.4:5');
    expect(requestIdFor(withHeader(['first', 'second']))).toBe('first');
  });

  it('replaces missing, unsafe or overlong IDs with a UUID', () => {
    const uuid = /^[0-9a-f-]{36}$/;
    expect(requestIdFor(withHeader())).toMatch(uuid);
    expect(requestIdFor(withHeader(''))).toMatch(uuid);
    expect(requestIdFor(withHeader('bad id\n<script>'))).toMatch(uuid);
    expect(requestIdFor(withHeader('a'.repeat(129)))).toMatch(uuid);
    expect(requestIdFor(withHeader('a'.repeat(128)))).toBe('a'.repeat(128));
  });
});
