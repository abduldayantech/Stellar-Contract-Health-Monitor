import { StrKey } from '@stellar/stellar-sdk';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import { createSecretBox, getPrisma } from '@stellar-health/db';
import type {
  ContractInfo,
  LedgerEntryTtl,
  RpcHealth,
  StellarClient,
} from '@stellar-health/stellar-client';
import { buildApp } from '../../src/app';
import { loadConfig } from '../../src/config';
import type { JobBus } from '../../src/lib/jobs';
import { createMetrics } from '../../src/lib/metrics';

export const ADMIN_TOKEN = 'integration-test-admin-token-0123456789';
export const TEST_SECRETS_KEY = 'ab'.repeat(32);
export const auth = { authorization: `Bearer ${ADMIN_TOKEN}` };

/** Deterministic, checksum-valid contract IDs. */
export function contractId(seed: number): string {
  return StrKey.encodeContract(Buffer.alloc(32, seed));
}

/** In-memory RPC: only contracts added with `deploy` exist on chain. */
export class FakeStellar implements StellarClient {
  health: RpcHealth = {
    status: 'healthy',
    latestLedger: 100_000,
    oldestLedger: 80_000,
    ledgerRetentionWindow: 20_000,
  };
  contracts = new Map<string, ContractInfo>();
  ttls = new Map<string, LedgerEntryTtl>();

  deploy(id: string): ContractInfo {
    const info: ContractInfo = {
      contractId: id,
      executableType: 'wasm',
      wasmHash: 'ab'.repeat(32),
      instanceLedgerKeyXdr: `instance-${id}`,
      codeLedgerKeyXdr: `code-${id}`,
      instanceLiveUntilLedger: this.health.latestLedger + 50_000,
      codeLiveUntilLedger: this.health.latestLedger + 90_000,
      latestLedger: this.health.latestLedger,
    };
    this.contracts.set(id, info);
    return info;
  }
  async getHealth() {
    return this.health;
  }
  async getNetworkPassphrase() {
    return 'Test SDF Network ; September 2015';
  }
  async getEvents(): Promise<never> {
    throw new Error('not used by the API');
  }
  async getContractInfo(id: string) {
    return this.contracts.get(id) ?? null;
  }
  async getLedgerEntryTtls(keys: string[]) {
    return {
      latestLedger: this.health.latestLedger,
      entries: keys.map(
        (k) =>
          this.ttls.get(k) ?? {
            ledgerKeyXdr: k,
            exists: true,
            liveUntilLedger: this.health.latestLedger + 1000,
            lastModifiedLedger: 1,
          },
      ),
    };
  }
}

export class FakeJobs implements JobBus {
  ingest: string[] = [];
  storage: string[] = [];
  deliveries: string[] = [];
  async enqueueIngest(id: string) {
    this.ingest.push(id);
  }
  async enqueueStorageCheck(id: string) {
    this.storage.push(id);
  }
  async enqueueDelivery(id: string) {
    this.deliveries.push(id);
  }
  async counts() {
    return { ingest: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 } };
  }
  async close() {}
}

export interface TestContext {
  app: FastifyInstance;
  stellar: FakeStellar;
  jobs: FakeJobs;
  prisma: ReturnType<typeof getPrisma>;
  /** 2xx JSON responses that did not match their OpenAPI response schema. */
  responseSchemaErrors: string[];
}

/**
 * Checks every successful JSON response against the schema documented for it in /openapi.json,
 * so the hand-written response schemas cannot drift from what the routes return.
 */
function checkResponsesAgainstSpec(app: FastifyInstance, errors: string[]) {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats.default(ajv);
  // Keyed by "<METHOD> <route> <status>". Compiled up front so checks add no latency to requests.
  const validators = new Map<string, ValidateFunction>();

  app.addHook('onReady', async () => {
    type Responses = Record<string, { content?: Record<string, { schema?: object }> }>;
    const spec = app.swagger() as {
      paths: Record<string, Record<string, { responses?: Responses }>>;
    };
    for (const [path, item] of Object.entries(spec.paths)) {
      const route = path.replace(/\{(\w+)\}/g, ':$1');
      for (const [method, op] of Object.entries(item)) {
        for (const [status, res] of Object.entries(op.responses ?? {})) {
          const schema = res.content?.['application/json']?.schema;
          if (schema)
            validators.set(`${method.toUpperCase()} ${route} ${status}`, ajv.compile(schema));
        }
      }
    }
  });

  app.addHook('onSend', async (req, reply, payload) => {
    const type = String(reply.getHeader('content-type') ?? '');
    if (reply.statusCode >= 300 || !type.includes('json') || typeof payload !== 'string') return;
    const route = req.routeOptions.url;
    if (!route || route === '/openapi.json' || route.startsWith('/docs')) return;
    const key = `${req.method} ${route} ${reply.statusCode}`;
    const validate = validators.get(key);
    if (!validate) errors.push(`${key}: no response schema documented`);
    else if (!validate(JSON.parse(payload)))
      errors.push(`${key}: ${ajv.errorsText(validate.errors)}`);
  });
}

export async function createTestApp(
  opts: { rateLimit?: number; rateLimitRedis?: Redis } = {},
): Promise<TestContext> {
  const prisma = getPrisma();
  const stellar = new FakeStellar();
  const jobs = new FakeJobs();
  const config = loadConfig({
    ...process.env,
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    ADMIN_API_TOKEN: ADMIN_TOKEN,
    RATE_LIMIT_PER_MINUTE: String(opts.rateLimit ?? 100_000),
  });
  const app = await buildApp({
    config,
    prisma,
    redis: { ping: async () => 'PONG' },
    stellar: async () => stellar,
    jobs,
    metrics: createMetrics(),
    secrets: createSecretBox(TEST_SECRETS_KEY),
    rateLimitRedis: opts.rateLimitRedis,
  });
  const responseSchemaErrors: string[] = [];
  checkResponsesAgainstSpec(app, responseSchemaErrors);
  await app.ready();
  return { app, stellar, jobs, prisma, responseSchemaErrors };
}
