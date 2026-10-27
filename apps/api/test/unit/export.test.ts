import { describe, expect, it } from 'vitest';
import { csvField, eventCsvRow, paginate, type ExportableEvent } from '../../src/lib/export';

const event: ExportableEvent = {
  eventId: '0000000001-0000000001',
  type: 'contract',
  ledger: 42,
  ledgerClosedAt: new Date('2026-10-26T12:00:00Z'),
  txHash: 'ab'.repeat(32),
  topics: ['transfer', 'GA,B'],
  value: { memo: 'say "hi"\nthere' },
  inSuccessfulContractCall: true,
  contract: { contractId: 'CABC' },
};

describe('csvField', () => {
  it('quotes commas, quotes and line breaks', () => {
    expect(csvField('plain')).toBe('plain');
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('line\nbreak')).toBe('"line\nbreak"');
    expect(csvField('cr\rlf')).toBe('"cr\rlf"');
  });

  it('defuses spreadsheet formulas but keeps negative numbers', () => {
    expect(csvField('=1+1')).toBe("'=1+1");
    expect(csvField('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvField('-cmd')).toBe("'-cmd");
    expect(csvField('-5')).toBe('-5');
  });
});

describe('eventCsvRow', () => {
  it('writes the columns in order with escaped topics and JSON value', () => {
    expect(eventCsvRow(event)).toBe(
      `42,2026-10-26T12:00:00.000Z,CABC,${'ab'.repeat(32)},contract,0000000001-0000000001,"transfer / GA,B","{""memo"":""say \\""hi\\""\\nthere""}"\r\n`,
    );
  });
});

describe('paginate', () => {
  it('pages with the last id as cursor and stops at the cap', async () => {
    const all = Array.from({ length: 25 }, (_, i) => ({ id: String(i) }));
    const calls: [string | undefined, number][] = [];
    const fetchPage = async (cursor: string | undefined, take: number) => {
      calls.push([cursor, take]);
      const start = cursor === undefined ? 0 : Number(cursor) + 1;
      return all.slice(start, start + take);
    };
    const out: string[] = [];
    for await (const r of paginate(fetchPage, 22, 10)) out.push(r.id);
    expect(out).toHaveLength(22);
    expect(calls).toEqual([
      [undefined, 10],
      ['9', 10],
      ['19', 2],
    ]);
    const rest: string[] = [];
    for await (const r of paginate(fetchPage, 1000, 10)) rest.push(r.id);
    expect(rest).toHaveLength(25);
  });
});
