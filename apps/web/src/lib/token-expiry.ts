const DAY = 86400_000;

export const EXPIRY_OPTIONS = [
  { value: '', label: 'Never' },
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '365', label: '1 year' },
] as const;

export interface TokenExpiry {
  label: string;
  tone: 'slate' | 'yellow' | 'red';
  /** True when the token stops working within 7 days (or already has). */
  soon: boolean;
}

/** How to show a token's expiry: "never", "in 12 days", amber within a week, red once expired. */
export function tokenExpiry(expiresAt: string | null, now: Date = new Date()): TokenExpiry {
  if (!expiresAt) return { label: 'Never', tone: 'slate', soon: false };
  const ms = new Date(expiresAt).getTime() - now.getTime();
  if (ms <= 0) return { label: 'Expired', tone: 'red', soon: true };
  const days = Math.ceil(ms / DAY);
  if (days <= 1) {
    const hours = Math.max(1, Math.ceil(ms / 3600_000));
    return { label: `in ${hours} hour${hours === 1 ? '' : 's'}`, tone: 'yellow', soon: true };
  }
  return { label: `in ${days} days`, tone: days <= 7 ? 'yellow' : 'slate', soon: days <= 7 };
}
