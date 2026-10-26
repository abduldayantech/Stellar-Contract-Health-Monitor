import { formatDuration, ledgersToDuration } from '@stellar-health/ui';
import type { AlertRule } from './types';

export const RULE_TYPE_LABELS: Record<AlertRule['type'], string> = {
  EVENT_MATCH: 'Event match',
  TTL_EXPIRY: 'Storage TTL expiry',
  INACTIVITY: 'Inactivity',
};

export interface ValueCondition {
  path: string;
  op: 'gt' | 'gte' | 'lt' | 'lte' | 'eq';
  value: string;
}

export const VALUE_OPS: [ValueCondition['op'], string][] = [
  ['gte', '≥ at least'],
  ['gt', '> more than'],
  ['lte', '≤ at most'],
  ['lt', '< less than'],
  ['eq', '= exactly'],
];

const OP_SYMBOLS: Record<ValueCondition['op'], string> = {
  gt: '>',
  gte: '≥',
  lt: '<',
  lte: '≤',
  eq: '=',
};

function describeCondition(c: ValueCondition): string {
  const field = c.path ? `value.${c.path}` : 'value';
  return `${field} ${OP_SYMBOLS[c.op]} ${BigInt(c.value).toLocaleString('en-US')}`;
}

/** One-line human description of what a rule does. */
export function describeRule(rule: Pick<AlertRule, 'type' | 'config' | 'cooldownSeconds'>): string {
  const c = rule.config as Record<string, unknown>;
  switch (rule.type) {
    case 'EVENT_MATCH': {
      const topics = (c.topics as string[] | undefined) ?? [];
      const what = topics.length ? `events with topics [${topics.join(', ')}]` : 'any event';
      const threshold = Number(c.threshold ?? 1);
      const condition = c.valueCondition
        ? ` where ${describeCondition(c.valueCondition as ValueCondition)}`
        : '';
      return threshold > 1
        ? `${threshold}+ ${what}${condition} within ${formatDuration(Number(c.windowSeconds ?? 300))}`
        : `On ${what}${condition}`;
    }
    case 'TTL_EXPIRY': {
      const ledgers = Number(c.ledgersThreshold ?? 0);
      return `Storage with < ${ledgers.toLocaleString()} ledgers (~${ledgersToDuration(ledgers)}) to live`;
    }
    case 'INACTIVITY':
      return `No events for ${formatDuration(Number(c.windowSeconds ?? 0))}`;
  }
}
