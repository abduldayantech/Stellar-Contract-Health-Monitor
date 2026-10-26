'use client';

import Link from 'next/link';
import { Fragment, useState } from 'react';
import { Badge, Mono, Table, Td, Th, formatDateTime, shortId, timeAgo } from '@stellar-health/ui';
import type { EventItem } from '@/lib/types';
import { CopyButton } from './copy-button';

function explorerTxUrl(network: string, txHash: string): string | null {
  if (network === 'TESTNET') return `https://stellar.expert/explorer/testnet/tx/${txHash}`;
  if (network === 'MAINNET') return `https://stellar.expert/explorer/public/tx/${txHash}`;
  return null;
}

function renderValue(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

export function EventTable({
  events,
  showContract = true,
  onTopicClick,
}: {
  events: EventItem[];
  showContract?: boolean;
  onTopicClick?: (topic: string) => void;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  return (
    <Table>
      <thead className="bg-slate-50 dark:bg-slate-900/50">
        <tr>
          <Th>Time</Th>
          {showContract && <Th>Contract</Th>}
          <Th>Topics</Th>
          <Th>Value</Th>
          <Th>Ledger</Th>
          <Th>Transaction</Th>
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
        {events.map((e) => {
          const isOpen = expanded === e.id;
          const txUrl = explorerTxUrl(e.network, e.txHash);
          return (
            <Fragment key={e.id}>
              <tr
                className="cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/50"
                onClick={() => setExpanded(isOpen ? null : e.id)}
                data-testid="event-row"
              >
                <Td className="whitespace-nowrap">
                  {/* The whole row toggles on click; this button makes it keyboard accessible. */}
                  <button
                    type="button"
                    aria-expanded={isOpen}
                    aria-label={`${isOpen ? 'Hide' : 'Show'} details for the event at ledger ${e.ledger}`}
                    title={formatDateTime(e.ledgerClosedAt)}
                    className="rounded text-left hover:underline focus-visible:outline-2 focus-visible:outline-indigo-600"
                    onClick={(ev) => {
                      ev.stopPropagation();
                      setExpanded(isOpen ? null : e.id);
                    }}
                  >
                    {timeAgo(e.ledgerClosedAt)}
                  </button>
                </Td>
                {showContract && (
                  <Td className="whitespace-nowrap">
                    <Link
                      href={`/contracts/${e.contractRefId}`}
                      onClick={(ev) => ev.stopPropagation()}
                      className="text-indigo-600 hover:underline dark:text-indigo-400"
                    >
                      {e.contractLabel ?? shortId(e.contractId)}
                    </Link>
                  </Td>
                )}
                <Td>
                  <div className="flex max-w-md flex-wrap gap-1">
                    {e.topics.map((t, i) => (
                      <button
                        key={i}
                        type="button"
                        title={onTopicClick ? `Filter by "${t}"` : t}
                        onClick={(ev) => {
                          if (!onTopicClick) return;
                          ev.stopPropagation();
                          onTopicClick(t);
                        }}
                        className={onTopicClick ? 'cursor-pointer' : 'cursor-default'}
                      >
                        <Badge tone={i === 0 ? 'indigo' : 'neutral'}>
                          {t.length > 20 ? shortId(t, 8, 6) : t}
                        </Badge>
                      </button>
                    ))}
                    {e.topics.length === 0 && (
                      <span className="text-xs text-slate-500 dark:text-slate-400">none</span>
                    )}
                  </div>
                </Td>
                <Td className="max-w-xs truncate">
                  <Mono>{renderValue(e.value).slice(0, 80)}</Mono>
                </Td>
                <Td className="tabular-nums">{e.ledger.toLocaleString()}</Td>
                <Td>
                  <Mono>{shortId(e.txHash, 8, 6)}</Mono>
                </Td>
              </tr>
              {isOpen && (
                <tr className="bg-slate-50 dark:bg-slate-900/60">
                  <Td colSpan={showContract ? 6 : 5}>
                    <dl className="grid gap-3 py-2 text-xs sm:grid-cols-2">
                      <div>
                        <dt className="font-medium text-slate-500 dark:text-slate-400">Event ID</dt>
                        <dd className="font-mono">{e.eventId}</dd>
                      </div>
                      <div>
                        <dt className="font-medium text-slate-500 dark:text-slate-400">
                          Closed at
                        </dt>
                        <dd>{formatDateTime(e.ledgerClosedAt)}</dd>
                      </div>
                      <div className="sm:col-span-2">
                        <dt className="font-medium text-slate-500 dark:text-slate-400">
                          Transaction
                        </dt>
                        <dd className="flex flex-wrap items-center gap-2 font-mono">
                          <span className="break-all">{e.txHash}</span>
                          <CopyButton value={e.txHash} />
                          {txUrl && (
                            <a
                              href={txUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="font-sans text-indigo-600 hover:underline dark:text-indigo-400"
                            >
                              View on explorer ↗
                            </a>
                          )}
                        </dd>
                      </div>
                      <div className="sm:col-span-2">
                        <dt className="font-medium text-slate-500 dark:text-slate-400">Topics</dt>
                        <dd className="space-y-0.5 font-mono break-all">
                          {e.topics.map((t, i) => (
                            <div key={i}>
                              [{i}] {t}
                            </div>
                          ))}
                        </dd>
                      </div>
                      <div className="sm:col-span-2">
                        <dt className="font-medium text-slate-500 dark:text-slate-400">
                          Value (decoded)
                        </dt>
                        <dd>
                          <pre className="mt-1 max-h-64 overflow-auto rounded bg-white p-2 font-mono text-xs dark:bg-slate-950">
                            {JSON.stringify(e.value, null, 2)}
                          </pre>
                        </dd>
                      </div>
                      <div className="sm:col-span-2">
                        <dt className="font-medium text-slate-500 dark:text-slate-400">
                          Value (XDR)
                        </dt>
                        <dd className="font-mono break-all">{e.valueXdr}</dd>
                      </div>
                    </dl>
                  </Td>
                </tr>
              )}
            </Fragment>
          );
        })}
      </tbody>
    </Table>
  );
}
