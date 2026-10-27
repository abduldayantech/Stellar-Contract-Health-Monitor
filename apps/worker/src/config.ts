import { hostname } from 'node:os';
import { z } from 'zod';
import { parseEncryptionKey } from '@stellar-health/db';

const bool = (def: boolean) =>
  z
    .enum(['true', 'false', '1', '0', ''])
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : v === 'true' || v === '1'));

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  WORKER_NAME: z.string().default(hostname()),
  WORKER_METRICS_PORT: z.coerce.number().int().default(4001),
  INGEST_INTERVAL_MS: z.coerce.number().int().min(1000).default(10_000),
  INGEST_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(5),
  INGEST_PAGE_LIMIT: z.coerce.number().int().min(1).max(10_000).default(200),
  /** Caught-up contracts polled per RPC call (1 disables batching; RPC maximum is 25). */
  INGEST_BATCH_SIZE: z.coerce.number().int().min(1).max(25).default(25),
  /** Contracts further behind than this are polled individually until they catch up. */
  INGEST_BATCH_MAX_LAG_LEDGERS: z.coerce.number().int().min(0).default(1000),
  INGEST_MAX_PAGES: z.coerce.number().int().min(1).max(1000).default(20),
  STORAGE_CHECK_INTERVAL_MS: z.coerce.number().int().min(10_000).default(300_000),
  INACTIVITY_CHECK_INTERVAL_MS: z.coerce.number().int().min(10_000).default(60_000),
  EVENT_RETENTION_DAYS: z.coerce.number().int().min(0).default(30),
  /** Delete audit log rows older than this many days; 0 keeps them forever. */
  AUDIT_LOG_RETENTION_DAYS: z.coerce.number().int().min(0).default(365),
  WEBHOOK_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60_000).default(10_000),
  WEBHOOK_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(6),
  WEBHOOK_BLOCK_PRIVATE_IPS: bool(false),
  NOTIFICATION_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(10),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().default(587),
  SMTP_SECURE: bool(false),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_FROM: z.string().default('Stellar Health Monitor <alerts@example.com>'),
  /** 32-byte key (hex or base64) for webhook secrets at rest; must match the API. */
  SECRETS_ENCRYPTION_KEY: z
    .string()
    .optional()
    .transform((v) => v?.trim() || undefined)
    .superRefine((v, ctx) => {
      if (!v) return;
      try {
        parseEncryptionKey(v);
      } catch (err) {
        ctx.addIssue({ code: 'custom', message: (err as Error).message });
      }
    }),
  PUBLIC_DASHBOARD_URL: z.string().default('http://localhost:3000'),
});

export type WorkerConfig = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid worker configuration:\n${issues}`);
  }
  if (parsed.data.NODE_ENV === 'production' && !parsed.data.SECRETS_ENCRYPTION_KEY) {
    throw new Error(
      'SECRETS_ENCRYPTION_KEY is required in production (generate with: openssl rand -base64 32)',
    );
  }
  return parsed.data;
}
