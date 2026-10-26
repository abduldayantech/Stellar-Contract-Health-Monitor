import { z } from 'zod';

/**
 * Positional topic filter. Each entry matches the topic at the same index.
 * "*" matches any single topic; "**" (only as the last entry) matches any remaining topics.
 * Topics are compared using their display form (symbols/strings/addresses as-is,
 * numbers as decimal strings, other values as compact JSON).
 */
export const topicFilterSchema = z.array(z.string().min(1).max(256)).max(4);

export const eventMatchConfigSchema = z.object({
  topics: topicFilterSchema.default([]),
  /** Number of matching events within `windowSeconds` required to trigger. */
  threshold: z.number().int().min(1).max(100_000).default(1),
  windowSeconds: z
    .number()
    .int()
    .min(1)
    .max(7 * 24 * 3600)
    .default(300),
  /** Also count events emitted by failed contract calls. */
  includeFailedCalls: z.boolean().default(false),
});
export type EventMatchConfig = z.infer<typeof eventMatchConfigSchema>;

export const ttlExpiryConfigSchema = z.object({
  /** Trigger when a monitored entry has fewer than this many ledgers left before it is archived/expires. */
  ledgersThreshold: z
    .number()
    .int()
    .min(1)
    .max(10_000_000)
    .default(17_280 * 7),
});
export type TtlExpiryConfig = z.infer<typeof ttlExpiryConfigSchema>;

export const inactivityConfigSchema = z.object({
  /** Trigger when the contract has emitted no events for this long. */
  windowSeconds: z
    .number()
    .int()
    .min(60)
    .max(90 * 24 * 3600)
    .default(24 * 3600),
});
export type InactivityConfig = z.infer<typeof inactivityConfigSchema>;

/** Triggers when a contract's WASM hash changes (an upgrade). No options yet. */
export const wasmChangedConfigSchema = z.object({});
export type WasmChangedConfig = z.infer<typeof wasmChangedConfigSchema>;

export const alertRuleConfigSchemas = {
  EVENT_MATCH: eventMatchConfigSchema,
  TTL_EXPIRY: ttlExpiryConfigSchema,
  INACTIVITY: inactivityConfigSchema,
  WASM_CHANGED: wasmChangedConfigSchema,
} as const;

export type AlertRuleConfig =
  | { type: 'EVENT_MATCH'; config: EventMatchConfig }
  | { type: 'TTL_EXPIRY'; config: TtlExpiryConfig }
  | { type: 'INACTIVITY'; config: InactivityConfig }
  | { type: 'WASM_CHANGED'; config: WasmChangedConfig };

export function parseRuleConfig(type: string, config: unknown): AlertRuleConfig {
  switch (type) {
    case 'EVENT_MATCH':
      return { type, config: eventMatchConfigSchema.parse(config ?? {}) };
    case 'TTL_EXPIRY':
      return { type, config: ttlExpiryConfigSchema.parse(config ?? {}) };
    case 'INACTIVITY':
      return { type, config: inactivityConfigSchema.parse(config ?? {}) };
    case 'WASM_CHANGED':
      return { type, config: wasmChangedConfigSchema.parse(config ?? {}) };
    default:
      throw new Error(`Unknown alert rule type: ${type}`);
  }
}
