/**
 * Ingestion load test: runs the real worker against a mock RPC with N synthetic contracts and
 * reports RPC calls per tick, stored events per second, ingestion lag and time spent per job.
 *
 *   pnpm bench:ingest -- --contracts 1000 [--duration 60] [--json out.json]
 *
 * Needs the dev Postgres and Redis (`pnpm services:up`). Uses its own database (schm_bench) and
 * Redis database 15, both wiped at the start of every run.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Redis } from 'ioredis';
import { PrismaClient } from '@stellar-health/db';
import { migrateTestDatabase, resetDatabase } from '../../../tests/support/test-db';
import { benchContractId, startMockRpc, type MockRpcStats } from './mock-rpc';

const { values: args } = parseArgs({
  options: {
    contracts: { type: 'string', default: '1000' },
    /** Seconds measured once every contract has caught up. */
    duration: { type: 'string', default: '60' },
    'ledger-ms': { type: 'string', default: '5000' },
    /** Each contract emits one event every this many ledgers. */
    'event-period': { type: 'string', default: '20' },
    latency: { type: 'string', default: '30' },
    interval: { type: 'string', default: '5000' },
    concurrency: { type: 'string', default: '5' },
    'batch-size': { type: 'string', default: '25' },
    /** Ledgers of history each contract backfills before it counts as caught up. */
    lookback: { type: 'string', default: '100' },
    'catch-up-timeout': { type: 'string', default: '600' },
    json: { type: 'string' },
  },
  // `pnpm bench:ingest -- --contracts 1000` forwards the `--` separator; drop it.
  args: process.argv.slice(2).filter((a) => a !== '--'),
});
const num = (k: keyof typeof args) => Number(args[k]);

const DATABASE_URL =
  process.env.BENCH_DATABASE_URL ??
  'postgresql://schm:schm@localhost:5432/schm_bench?schema=public';
const REDIS_URL = process.env.BENCH_REDIS_URL ?? 'redis://localhost:6379/15';
const workerDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (msg: string) => console.error(`[bench] ${msg}`);

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolvePort(port));
    });
    srv.on('error', reject);
  });
}

/** Sums every sample of a Prometheus metric (all label combinations). */
function metricSum(text: string, name: string, filter = ''): number {
  let total = 0;
  for (const line of text.split('\n')) {
    if (!line.startsWith(name) || line[name.length] === '_') continue;
    if (filter && !line.includes(filter)) continue;
    const value = Number(line.slice(line.lastIndexOf(' ') + 1));
    if (Number.isFinite(value)) total += value;
  }
  return total;
}

interface Snapshot {
  at: number;
  rpc: MockRpcStats;
  events: number;
  ingestSeconds: number;
  ingestJobs: number;
  rpcSeconds: number;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

async function main() {
  const contracts = num('contracts');
  const ledgerMs = num('ledger-ms');
  const intervalMs = num('interval');

  log(`preparing database ${new URL(DATABASE_URL).pathname.slice(1)} and redis ${REDIS_URL}`);
  migrateTestDatabase(DATABASE_URL);
  const prisma = new PrismaClient({ datasourceUrl: DATABASE_URL });
  await resetDatabase(prisma);
  const redis = new Redis(REDIS_URL);
  await redis.flushdb();
  await redis.quit();

  const mock = await startMockRpc({
    ledgerMs,
    eventPeriod: num('event-period'),
    latencyMs: num('latency'),
  });
  const startLedger = mock.latestLedger() - num('lookback');
  log(`mock RPC at ${mock.url}, ledger ${mock.latestLedger()}; seeding ${contracts} contracts`);
  for (let i = 0; i < contracts; i += 5000) {
    await prisma.contract.createMany({
      data: Array.from({ length: Math.min(5000, contracts - i) }, (_, j) => ({
        contractId: benchContractId(i + j),
        network: 'TESTNET' as const,
        label: `bench-${i + j}`,
        startLedger,
      })),
    });
  }

  const metricsPort = await freePort();
  const logFile = join(tmpdir(), `schm-bench-worker-${process.pid}.log`);
  const worker: ChildProcess = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: workerDir,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      LOG_LEVEL: 'warn',
      DATABASE_URL,
      REDIS_URL,
      TESTNET_RPC_URL: mock.url,
      WORKER_NAME: 'bench',
      WORKER_METRICS_PORT: String(metricsPort),
      INGEST_INTERVAL_MS: String(intervalMs),
      INGEST_CONCURRENCY: args.concurrency,
      INGEST_BATCH_SIZE: args['batch-size'],
      STORAGE_CHECK_INTERVAL_MS: '86400000',
      INACTIVITY_CHECK_INTERVAL_MS: '86400000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out = createWriteStream(logFile);
  worker.stdout!.pipe(out);
  worker.stderr!.pipe(out);
  let exited = false;
  worker.on('exit', (code) => {
    exited = true;
    if (code) log(`worker exited with code ${code}; log: ${logFile}`);
  });

  const snapshot = async (): Promise<Snapshot> => {
    const text = await fetch(`http://127.0.0.1:${metricsPort}/metrics`).then((r) => r.text());
    return {
      at: Date.now(),
      rpc: mock.stats(),
      events: await prisma.event.count(),
      ingestSeconds: metricSum(text, 'schm_ingest_duration_seconds_sum'),
      ingestJobs: metricSum(text, 'schm_ingest_duration_seconds_count'),
      rpcSeconds: metricSum(text, 'schm_rpc_call_duration_seconds_sum'),
    };
  };
  /** Ledgers between the RPC tip and the furthest-behind contract. */
  const lag = async () => {
    const r = await prisma.contract.aggregate({ _min: { lastIngestedLedger: true } });
    const behind = await prisma.contract.count({ where: { lastIngestedLedger: null } });
    const min = r._min.lastIngestedLedger;
    return behind > 0 || min === null ? Infinity : mock.latestLedger() - min;
  };

  try {
    // ---- Phase 1: backfill until every contract is within one tick of the tip ----
    const t0 = Date.now();
    const tickLedgers = Math.ceil(intervalMs / ledgerMs) + 1;
    const timeoutMs = num('catch-up-timeout') * 1000;
    for (;;) {
      if (exited) throw new Error(`worker stopped during catch-up; log: ${logFile}`);
      const l = await lag().catch(() => Infinity);
      if (l <= tickLedgers) break;
      if (Date.now() - t0 > timeoutMs) throw new Error(`not caught up after ${timeoutMs / 1000}s`);
      await sleep(1000);
    }
    const catchUpSeconds = (Date.now() - t0) / 1000;
    log(`caught up in ${catchUpSeconds.toFixed(1)}s; measuring for ${args.duration}s`);

    // ---- Phase 2: steady state ----
    const start = await snapshot();
    const lags: number[] = [];
    const end = start.at + num('duration') * 1000;
    while (Date.now() < end) {
      if (exited) throw new Error(`worker stopped; log: ${logFile}`);
      await sleep(1000);
      lags.push(await lag());
    }
    const stop = await snapshot();

    const seconds = (stop.at - start.at) / 1000;
    const ticks = seconds / (intervalMs / 1000);
    const callsBy = (m: string) => (stop.rpc.calls[m] ?? 0) - (start.rpc.calls[m] ?? 0);
    const allCalls =
      Object.values(stop.rpc.calls).reduce((a, b) => a + b, 0) -
      Object.values(start.rpc.calls).reduce((a, b) => a + b, 0);
    const jobs = stop.ingestJobs - start.ingestJobs;
    const jobSeconds = stop.ingestSeconds - start.ingestSeconds;
    const rpcSeconds = stop.rpcSeconds - start.rpcSeconds;
    const expectedEventsPerSecond = contracts / num('event-period') / (ledgerMs / 1000);

    const result = {
      contracts,
      settings: {
        ledgerMs,
        eventPeriod: num('event-period'),
        rpcLatencyMs: num('latency'),
        ingestIntervalMs: intervalMs,
        ingestConcurrency: num('concurrency'),
        batchSize: num('batch-size'),
      },
      catchUpSeconds: Number(catchUpSeconds.toFixed(1)),
      measuredSeconds: Number(seconds.toFixed(1)),
      getEventsPerTick: Number((callsBy('getEvents') / ticks).toFixed(1)),
      rpcCallsPerTick: Number((allCalls / ticks).toFixed(1)),
      rpcErrors: stop.rpc.errors - start.rpc.errors,
      eventsPerSecond: Number(((stop.events - start.events) / seconds).toFixed(1)),
      expectedEventsPerSecond: Number(expectedEventsPerSecond.toFixed(1)),
      lagLedgers: { max: Math.max(...lags), p95: percentile(lags, 95) },
      ingestJobsPerTick: Number((jobs / ticks).toFixed(1)),
      msPerJob: Number(((jobSeconds / Math.max(1, jobs)) * 1000).toFixed(1)),
      /** Job time not spent waiting on RPC: mostly Postgres. */
      nonRpcMsPerJob: Number((((jobSeconds - rpcSeconds) / Math.max(1, jobs)) * 1000).toFixed(1)),
    };

    console.log(`
| Contracts | Catch-up | getEvents / tick | RPC calls / tick | Events/s (expected) | Lag max / p95 | ms per job (non-RPC) |
| --------- | -------- | ---------------- | ---------------- | ------------------- | ------------- | -------------------- |
| ${contracts} | ${result.catchUpSeconds}s | ${result.getEventsPerTick} | ${result.rpcCallsPerTick} | ${result.eventsPerSecond} (${result.expectedEventsPerSecond}) | ${result.lagLedgers.max} / ${result.lagLedgers.p95} | ${result.msPerJob} (${result.nonRpcMsPerJob}) |
`);
    if (result.rpcErrors > 0) log(`warning: ${result.rpcErrors} RPC errors during measurement`);
    if (args.json) await writeFile(args.json, JSON.stringify(result, null, 2) + '\n');
  } finally {
    worker.kill('SIGTERM');
    await new Promise((r) => (exited ? r(null) : worker.once('exit', r)));
    await mock.close();
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
