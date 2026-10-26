import { describe, expect, it } from 'vitest';
import { tokenExpiry } from '@/lib/token-expiry';

const now = new Date('2026-10-26T12:00:00Z');
const inDays = (d: number) => new Date(now.getTime() + d * 86400_000).toISOString();

describe('tokenExpiry', () => {
  it('shows tokens without an expiry as never expiring', () => {
    expect(tokenExpiry(null, now)).toEqual({ label: 'Never', tone: 'slate', soon: false });
  });

  it('highlights tokens expiring within 7 days', () => {
    expect(tokenExpiry(inDays(30), now)).toEqual({
      label: 'in 30 days',
      tone: 'slate',
      soon: false,
    });
    expect(tokenExpiry(inDays(7), now)).toMatchObject({ label: 'in 7 days', soon: true });
    expect(tokenExpiry(inDays(0.1), now)).toMatchObject({ label: 'in 3 hours', tone: 'yellow' });
  });

  it('marks past expiry dates as expired', () => {
    expect(tokenExpiry(inDays(-1), now)).toEqual({ label: 'Expired', tone: 'red', soon: true });
  });
});
