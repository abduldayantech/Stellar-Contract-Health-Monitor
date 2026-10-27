/** Hard cap on rows in one export, so a single request can't run unbounded. */
export const EXPORT_MAX_ROWS = 100_000;
/** Rows fetched per database query while streaming. */
export const EXPORT_PAGE_SIZE = 1000;

export const EVENT_CSV_COLUMNS = [
  'ledger',
  'ledgerClosedAt',
  'contractId',
  'txHash',
  'type',
  'eventId',
  'topics',
  'value',
] as const;

export interface ExportableEvent {
  eventId: string;
  type: string;
  ledger: number;
  ledgerClosedAt: Date;
  txHash: string;
  topics: string[];
  value: unknown;
  inSuccessfulContractCall: boolean;
  contract: { contractId: string };
}

/**
 * Quotes a CSV field when it contains a comma, quote or line break (RFC 4180), and defuses
 * values that spreadsheets would run as formulas (=, +, @, or - not followed by a digit).
 */
export function csvField(value: string): string {
  let v = value;
  if (/^[=+@\t\r]/.test(v) || /^-(?![\d.])/.test(v)) v = `'${v}`;
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function eventCsvHeader(): string {
  return `${EVENT_CSV_COLUMNS.join(',')}\r\n`;
}

export function eventCsvRow(e: ExportableEvent): string {
  return `${[
    String(e.ledger),
    e.ledgerClosedAt.toISOString(),
    e.contract.contractId,
    e.txHash,
    e.type,
    e.eventId,
    e.topics.join(' / '),
    JSON.stringify(e.value),
  ]
    .map(csvField)
    .join(',')}\r\n`;
}

export function eventNdjsonRow(e: ExportableEvent): string {
  return `${JSON.stringify({
    eventId: e.eventId,
    contractId: e.contract.contractId,
    type: e.type,
    ledger: e.ledger,
    ledgerClosedAt: e.ledgerClosedAt.toISOString(),
    txHash: e.txHash,
    topics: e.topics,
    value: e.value,
    inSuccessfulContractCall: e.inSuccessfulContractCall,
  })}\n`;
}

/** Reads rows page by page with keyset paging, so memory use stays flat for large exports. */
export async function* paginate<T extends { id: string }>(
  fetchPage: (cursor: string | undefined, take: number) => Promise<T[]>,
  max = EXPORT_MAX_ROWS,
  pageSize = EXPORT_PAGE_SIZE,
): AsyncGenerator<T> {
  let cursor: string | undefined;
  let sent = 0;
  while (sent < max) {
    const take = Math.min(pageSize, max - sent);
    const rows = await fetchPage(cursor, take);
    for (const row of rows) yield row;
    sent += rows.length;
    if (rows.length < take) return;
    cursor = rows[rows.length - 1]!.id;
  }
}
