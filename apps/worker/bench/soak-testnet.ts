/**
 * Testnet soak test: runs the real API and worker against Stellar testnet, monitors the most
 * active contracts through the public API, and at the end checks every stored event against
 * the RPC (nothing missed, nothing duplicated).
 *
 *   pnpm soak:testnet -- --minutes 60 [--contracts 30] [--lookback 720] [--json out.json]
 *
 * Needs the dev Postgres and Redis (`pnpm services:up`) and outbound HTTPS to the testnet RPC.
 * Uses its own database (schm_soak) and Redis database 14, both wiped at the start.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { createWriteStream, readFileSync } from 'node:fs';
import { appendFile, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, parseEnv } from 'node:util';
import { Redis } from 'ioredis';
import { PrismaClient } from '@stellar-health/db';
import { StellarRpcClient } from '@stellar-health/stellar-client';
import { migrateTestDatabase, resetDatabase } from '../../../tests/support/test-db';

const { values: args } = parseArgs({
  options: {
    minutes: { type: 'string', default: '60' },
    contracts: { type: 'string', default: '30' },
    /** Ledgers of history to backfill per contract (720 ≈ 1 hour). */
    lookback: { type: 'string', default: '720' },
    'sample-seconds': { type: 'string', default: '30' },
    rpc: { type: 'string', default: 'https://soroban-testnet.stellar.org' },
    json: { type: 'string' },
  },
  args: process.argv.slice(2).filter((a) => a !== '--'),
});

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const DATABASE_URL =
  process.env.SOAK_DATABASE_URL ?? 'postgresql://schm:schm@localhost:5432/schm_soak?schema=public';
const REDIS_URL = process.env.SOAK_REDIS_URL ?? 'redis://localhost:6379/14';
const API_PORT = 4020;
const WORKER_PORT = 4021;
const ADMIN_TOKEN = 'soak-admin-token-0123456789abcdef';
const WEBHOOK_SECRET = 'whsec_soak_0123456789abcdef';
const ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
const RPC = args.rpc;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (msg: string) => console.error(`[soak ${new Date().toISOString()}] ${msg}`);
const cursorLedger = (cursor: string) => Number(BigInt(cursor.split('-')[0]!) >> 32n);

async function rpcCall<T>(method: string, params?: unknown): Promise<T> {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result!;
}

/** The contracts that emitted the most events over the last ~200 ledgers. */
async function busiestContracts(n: number): Promise<string[]> {
  const { sequence } = await rpcCall<{ sequence: number }>('getLatestLedger');
  const res = await rpcCall<{ events: { contractId: string }[] }>('getEvents', {
    startLedger: sequence - 200,
    filters: [{ type: 'contract' }],
    pagination: { limit: 10_000 },
  });
  const counts = new Map<string, number>();
  for (const e of res.events) counts.set(e.contractId, (counts.get(e.contractId) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([id]) => id);
}

/** Every event ID the RPC has for one contract from `fromLedger` up to and including `cursor`. */
async function rpcEventIds(
  client: StellarRpcClient,
  contractId: string,
  fromLedger: number,
  cursor: string,
) {
  const ids: string[] = [];
  let page = await client.getEvents({
    contractIds: [contractId],
    startLedger: fromLedger,
    limit: 10_000,
  });
  for (;;) {
    for (const e of page.events) if (e.id <= cursor) ids.push(e.id);
    const done = page.events.length < 10_000 || page.events.at(-1)!.id > cursor;
    if (done) break;
    page = await client.getEvents({
      contractIds: [contractId],
      cursor: page.cursor,
      limit: 10_000,
    });
  }
  return ids;
}

function rssMb(pid: number | undefined): number | null {
  if (!pid) return null;
  try {
    const m = /VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'));
    return m ? Math.round(Number(m[1]) / 1024) : null;
  } catch {
    return null;
  }
}

function metric(text: string, name: string, filter = ''): number {
  let total = 0;
  for (const line of text.split('\n')) {
    if (!line.startsWith(name) || line[name.length] === '_') continue;
    if (filter && !line.includes(filter)) continue;
    const v = Number(line.slice(line.lastIndexOf(' ') + 1));
    if (Number.isFinite(v)) total += v;
  }
  return total;
}

async function main() {
  const minutes = Number(args.minutes);
  log(`preparing database schm_soak and redis ${REDIS_URL}`);
  migrateTestDatabase(DATABASE_URL);
  const prisma = new PrismaClient({ datasourceUrl: DATABASE_URL });
  await resetDatabase(prisma);
  const redis = new Redis(REDIS_URL);
  await redis.flushdb();
  await redis.quit();

  // ---- Webhook receiver: counts deliveries and checks signatures ----
  const webhooks = { received: 0, badSignature: 0, byEvent: {} as Record<string, number> };
  const receiver = createServer((req: IncomingMessage, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const expected = `sha256=${createHmac('sha256', WEBHOOK_SECRET)
        .update(`${req.headers['x-schm-timestamp']}.${body}`)
        .digest('hex')}`;
      webhooks.received++;
      if (req.headers['x-schm-signature'] !== expected) webhooks.badSignature++;
      try {
        const kind = (JSON.parse(body) as { type?: string }).type ?? 'unknown';
        webhooks.byEvent[kind] = (webhooks.byEvent[kind] ?? 0) + 1;
      } catch {
        /* counted above */
      }
      res.end('ok');
    });
  });
  await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
  const webhookUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hook`;

  // ---- Start the API and worker ----
  const fileEnv = parseEnv(readFileSync(join(root, '.env.example'), 'utf8'));
  const env = {
    ...fileEnv,
    ...process.env,
    NODE_ENV: 'test',
    LOG_LEVEL: 'warn',
    DATABASE_URL,
    REDIS_URL,
    TESTNET_RPC_URL: RPC,
    ADMIN_API_TOKEN: ADMIN_TOKEN,
    SECRETS_ENCRYPTION_KEY: ENCRYPTION_KEY,
    API_PORT: String(API_PORT),
    API_HOST: '127.0.0.1',
    WORKER_NAME: 'soak',
    WORKER_METRICS_PORT: String(WORKER_PORT),
    STORAGE_CHECK_INTERVAL_MS: '120000',
    INACTIVITY_CHECK_INTERVAL_MS: '60000',
    WEBHOOK_BLOCK_PRIVATE_IPS: 'false',
  };
  const logFile = join(tmpdir(), `schm-soak-${process.pid}.log`);
  const out = createWriteStream(logFile);
  const procs: Record<string, ChildProcess> = {};
  for (const app of ['api', 'worker']) {
    const p = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
      cwd: join(root, 'apps', app),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    p.stdout!.on('data', (d) => out.write(`[${app}] ${d}`));
    p.stderr!.on('data', (d) => out.write(`[${app}] ${d}`));
    p.on('exit', (code) => code && log(`${app} exited with code ${code}; log: ${logFile}`));
    procs[app] = p;
  }
  log(`api and worker starting; log: ${logFile}`);

  const api = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await fetch(`http://127.0.0.1:${API_PORT}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${ADMIN_TOKEN}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text}`);
    return (text ? JSON.parse(text) : null) as T;
  };
  for (let i = 0; ; i++) {
    const ok = await fetch(`http://127.0.0.1:${API_PORT}/ready`).then(
      (r) => r.ok,
      () => false,
    );
    if (ok) break;
    if (i > 60) throw new Error(`API did not become ready; log: ${logFile}`);
    await sleep(1000);
  }

  // ---- Configure monitoring through the API, like a user would ----
  const ids = await busiestContracts(Number(args.contracts));
  const registered: { id: string; contractId: string; startLedger: number }[] = [];
  const registerErrors: string[] = [];
  for (const contractId of ids) {
    try {
      const c = await api<{ id: string; startLedger: number }>('POST', '/contracts', {
        contractId,
        network: 'TESTNET',
        lookbackLedgers: Number(args.lookback),
      });
      registered.push({ id: c.id, contractId, startLedger: c.startLedger });
    } catch (err) {
      registerErrors.push(`${contractId}: ${(err as Error).message}`);
    }
  }
  log(`registered ${registered.length}/${ids.length} contracts`);
  const dest = await api<{ id: string }>('POST', '/destinations', {
    type: 'WEBHOOK',
    name: 'soak receiver',
    config: { url: webhookUrl, secret: WEBHOOK_SECRET },
  });
  const destinationIds = [dest.id];
  await api('POST', '/alert-rules', {
    name: 'Transfer burst',
    type: 'EVENT_MATCH',
    severity: 'WARNING',
    cooldownSeconds: 600,
    destinationIds,
    config: { topics: ['transfer'], threshold: 50, windowSeconds: 300 },
  });
  await api('POST', '/alert-rules', {
    name: 'Quiet for 10 minutes',
    type: 'INACTIVITY',
    severity: 'INFO',
    destinationIds,
    config: { windowSeconds: 600 },
  });
  await api('POST', '/alert-rules', {
    name: 'Instance TTL under 30 days',
    type: 'TTL_EXPIRY',
    severity: 'CRITICAL',
    destinationIds,
    config: { ledgersThreshold: 17_280 * 30 },
  });

  // ---- Soak ----
  const samplesFile = join(tmpdir(), `schm-soak-samples-${process.pid}.jsonl`);
  const samples: Record<string, number | null>[] = [];
  const end = Date.now() + minutes * 60_000;
  const t0 = Date.now();
  log(`soaking for ${minutes} minutes; samples: ${samplesFile}`);
  while (Date.now() < end) {
    await sleep(Number(args['sample-seconds']) * 1000);
    try {
      const statusStart = Date.now();
      const status = await api<{ workerHealthy?: boolean }>('GET', '/status');
      const statusMs = Date.now() - statusStart;
      const listStart = Date.now();
      await api('GET', '/contracts');
      await api('GET', '/events?limit=50');
      const listMs = Date.now() - listStart;
      const m = await fetch(`http://127.0.0.1:${WORKER_PORT}/metrics`).then((r) => r.text());
      const { sequence } = await rpcCall<{ sequence: number }>('getLatestLedger');
      const rows = await prisma.contract.findMany({ select: { cursor: true } });
      const trueLag = Math.max(
        ...rows.map((r) => (r.cursor ? sequence - cursorLedger(r.cursor) : Infinity)),
      );
      const sample = {
        minute: Number(((Date.now() - t0) / 60_000).toFixed(1)),
        workerHealthy: status.workerHealthy ? 1 : 0,
        reportedLagMax: metric(m, 'schm_ingestion_lag_ledgers_max'),
        trueLagMax: Number.isFinite(trueLag) ? trueLag : null,
        events: await prisma.event.count(),
        ingestErrors: metric(m, 'schm_ingest_runs_total', 'result="error"'),
        rpcErrors: metric(m, 'schm_rpc_calls_total', 'result="error"'),
        rpcRetries: metric(m, 'schm_rpc_retries_total'),
        rpcCalls: metric(m, 'schm_rpc_calls_total'),
        gaps: metric(m, 'schm_ingestion_gaps_total'),
        alertsOpen: await prisma.alert.count({ where: { status: { not: 'RESOLVED' } } }),
        alertsTotal: await prisma.alert.count(),
        webhooks: webhooks.received,
        queueWaiting: metric(m, 'schm_queue_jobs', 'state="waiting"'),
        statusMs,
        listMs,
        workerRssMb: rssMb(procs.worker!.pid),
        apiRssMb: rssMb(procs.api!.pid),
      };
      samples.push(sample);
      await appendFile(samplesFile, JSON.stringify(sample) + '\n');
      log(
        `min ${sample.minute}: events ${sample.events}, lag ${sample.trueLagMax} (reported ${sample.reportedLagMax}), ` +
          `errors ${sample.ingestErrors}, alerts ${sample.alertsTotal}, webhooks ${sample.webhooks}, ` +
          `rss worker ${sample.workerRssMb}MB api ${sample.apiRssMb}MB`,
      );
    } catch (err) {
      log(`sample failed: ${(err as Error).message}`);
    }
  }

  // ---- Stop the worker, then compare what we stored with what the RPC has ----
  log('stopping worker and verifying stored events against the RPC');
  procs.worker!.kill('SIGTERM');
  await new Promise((r) => procs.worker!.once('exit', r));
  const client = new StellarRpcClient({ rpcUrl: RPC, retries: 3, timeoutMs: 60_000 });
  const verification: {
    contractId: string;
    rpc: number;
    stored: number;
    missing: number;
    extra: number;
  }[] = [];
  for (const r of registered) {
    const c = await prisma.contract.findUniqueOrThrow({ where: { id: r.id } });
    if (!c.cursor) {
      verification.push({ contractId: r.contractId, rpc: -1, stored: 0, missing: -1, extra: 0 });
      continue;
    }
    const fromRpc = new Set(await rpcEventIds(client, r.contractId, r.startLedger, c.cursor));
    const stored = await prisma.event.findMany({
      where: { contractRefId: r.id },
      select: { eventId: true },
    });
    const storedIds = stored.map((e) => e.eventId).filter((id) => id <= c.cursor!);
    const storedSet = new Set(storedIds);
    verification.push({
      contractId: r.contractId,
      rpc: fromRpc.size,
      stored: storedSet.size,
      missing: [...fromRpc].filter((id) => !storedSet.has(id)).length,
      extra:
        storedIds.filter((id) => !fromRpc.has(id)).length + (storedIds.length - storedSet.size),
    });
  }
  const deliveries = await prisma.notificationDelivery.groupBy({ by: ['status'], _count: true });

  const last = samples.at(-1) ?? {};
  const max = (k: string) => Math.max(...samples.map((s) => Number(s[k] ?? 0)));
  const result = {
    minutes,
    contracts: registered.length,
    registerErrors,
    eventsStored: last.events,
    trueLagMaxAfterCatchUp: Math.max(
      ...samples
        .filter((s) => s.minute! > Math.min(5, minutes / 3))
        .map((s) => Number(s.trueLagMax ?? Infinity)),
    ),
    ingestErrors: last.ingestErrors,
    rpcErrors: last.rpcErrors,
    rpcRetries: last.rpcRetries,
    rpcCalls: last.rpcCalls,
    gaps: last.gaps,
    alerts: last.alertsTotal,
    webhooks,
    deliveries: Object.fromEntries(deliveries.map((d) => [d.status, d._count])),
    statusMsMax: max('statusMs'),
    listMsMax: max('listMs'),
    workerRssMb: {
      first: samples[0]?.workerRssMb,
      last: last.workerRssMb,
      max: max('workerRssMb'),
    },
    apiRssMb: { first: samples[0]?.apiRssMb, last: last.apiRssMb, max: max('apiRssMb') },
    verification: {
      contracts: verification.length,
      rpcEvents: verification.reduce((a, v) => a + Math.max(0, v.rpc), 0),
      missing: verification.reduce((a, v) => a + Math.max(0, v.missing), 0),
      extra: verification.reduce((a, v) => a + v.extra, 0),
      mismatched: verification.filter((v) => v.missing !== 0 || v.extra !== 0),
    },
    samplesFile,
    logFile,
  };
  console.log(JSON.stringify(result, null, 2));
  if (args.json) await writeFile(args.json, JSON.stringify(result, null, 2) + '\n');

  procs.api!.kill('SIGTERM');
  receiver.close();
  await prisma.$disconnect();
  process.exit(result.verification.missing || result.verification.extra ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
