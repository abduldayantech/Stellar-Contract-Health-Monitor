# Performance

Two repeatable harnesses live in `apps/worker/bench`:

- **`pnpm bench:ingest`** runs the real worker against a mock Stellar RPC with any number of
  synthetic contracts, and reports RPC calls, throughput, lag and time per job.
- **`pnpm soak:testnet`** runs the real API and worker against Stellar testnet, monitors its busiest
  contracts through the public API, and at the end checks every stored event against the RPC.

Both need the dev Postgres and Redis (`pnpm services:up`). They use their own databases
(`schm_bench`, `schm_soak`) and Redis databases (15, 14), which they wipe on every run.

## Ingestion load test

```bash
pnpm bench:ingest -- --contracts 1000 [--duration 60] [--json result.json]
```

The mock (`bench/mock-rpc.ts`) behaves like stellar-rpc where it matters: event IDs and cursors
have the same format, `getEvents` enforces the 5 × 5 contract filter limit, and positions outside
the retention window are rejected. A ledger closes every `--ledger-ms` (5 s) and each contract
emits one event every `--event-period` ledgers (20), with `--latency` ms (30) added per call.

The run seeds the contracts 100 ledgers behind, waits until every contract is within one tick of
the tip, and then measures for `--duration` seconds:

| Column           | Meaning                                                                       |
| ---------------- | ----------------------------------------------------------------------------- |
| Catch-up         | Time for every contract to backfill 100 ledgers and reach the tip             |
| getEvents / tick | RPC calls per ingestion interval once caught up                               |
| Events/s         | Events stored per second, against what the mock emits                         |
| Lag max / p95    | Ledgers between the RPC tip and the furthest-behind contract, sampled per sec |
| ms per job       | Average ingestion job time; in brackets the part not spent waiting on the RPC |

### Results

2-core Codespace, Postgres 17 and Redis 7 in Docker, default worker settings
(`INGEST_INTERVAL_MS=5000` for the run, `INGEST_CONCURRENCY=5`, `INGEST_BATCH_SIZE=25`):

| Contracts | Catch-up | getEvents / tick | Events/s (emitted) | Lag max / p95 | ms per job (non-RPC) |
| --------- | -------- | ---------------- | ------------------ | ------------- | -------------------- |
| 100       | 4 s      | 4                | 1 (1)              | 1 / 1         | 81 (44)              |
| 1,000     | 20 s     | 40               | 10 (10)            | 1 / 1         | 56 (23)              |
| 5,000     | 99 s     | 203              | 50 (50)            | 1 / 1         | 50 (18)              |

Batching keeps RPC load at one call per 25 contracts per tick, so 1,000 contracts at the default
10 s interval cost about 4 calls per second.

Before batched inserts and updates (each batch checked and wrote every contract separately),
the same 5,000-contract run spent 180 ms of database time per job: the worker only got through
113 of the 200 batches each tick and lag rose to 3 ledgers. For larger fleets raise
`INGEST_CONCURRENCY` (and the Postgres connection pool) or run more worker replicas.

## Testnet soak test

```bash
pnpm soak:testnet -- --minutes 60 [--contracts 30] [--lookback 720] [--json result.json]
```

The soak test picks the `--contracts` most active contracts on testnet, registers them through
`POST /contracts` with `--lookback` ledgers of history, and adds three alert rules (a transfer
burst, 10 minutes of inactivity and instance TTL under 30 days) that deliver to a local, signed
webhook receiver. Every 30 seconds it records lag, errors, alerts, webhook deliveries, API latency
and memory. At the end it stops the worker and compares every stored event ID with what the RPC
returns for the same range, and exits non-zero on any missing or extra event.
