/** Ledgers close about every 5 seconds. */
const LEDGERS_PER_HOUR = 720;

export const BACKFILL_OPTIONS = [
  { value: 'none', label: 'None (new events only)', ledgers: 0 },
  { value: '1h', label: 'Last hour', ledgers: LEDGERS_PER_HOUR },
  { value: '1d', label: 'Last day', ledgers: 24 * LEDGERS_PER_HOUR },
  { value: '7d', label: 'Last 7 days', ledgers: 7 * 24 * LEDGERS_PER_HOUR },
] as const;

export type BackfillChoice = (typeof BACKFILL_OPTIONS)[number]['value'];
export const DEFAULT_BACKFILL: BackfillChoice = '1d';

export function backfillLedgers(choice: BackfillChoice): number {
  return BACKFILL_OPTIONS.find((o) => o.value === choice)?.ledgers ?? 17_280;
}
