# Deployment

## Docker Compose (single host)

```bash
cp .env.example .env
# Required: ADMIN_API_TOKEN (openssl rand -hex 32), SECRETS_ENCRYPTION_KEY (openssl rand -base64 32)
# and POSTGRES_PASSWORD.
# Mainnet needs MAINNET_RPC_URL – SDF does not run a free public mainnet RPC.
docker compose up -d --build
```

This starts Postgres, Redis, a one-off `migrate` job (`prisma migrate deploy`), the API, the
worker and the dashboard on `WEB_PORT` (default 3000). Only the dashboard is published; it reaches
the API over the internal network.

Put a TLS-terminating reverse proxy (Caddy, nginx, a cloud load balancer) in front of the
dashboard and set `SESSION_COOKIE_SECURE=true` and `PUBLIC_DASHBOARD_URL=https://…`.

## Images

`docker/Dockerfile` builds three images, published to GHCR on version tags by
`.github/workflows/release.yml`:

| Target   | Runs                                                               | Port | Health                        |
| -------- | ------------------------------------------------------------------ | ---- | ----------------------------- |
| `api`    | `node dist/index.js` (also contains the Prisma CLI for migrations) | 4000 | `GET /health`, `GET /ready`   |
| `worker` | `node dist/index.js`                                               | 4001 | `GET /health`, `GET /metrics` |
| `web`    | Next.js standalone server                                          | 3000 | `GET /api/health`             |

Run migrations before starting a new version:

```bash
docker run --rm -e DATABASE_URL=… <api-image> ./node_modules/.bin/prisma migrate deploy --schema prisma/schema.prisma
```

All images run as the unprivileged `node` user.

## Configuration

See [`.env.example`](../.env.example) for every variable. The important ones:

| Variable                                                  | Service     | Notes                                                                                                                                                                                                                |
| --------------------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                            | api, worker | PostgreSQL 15+                                                                                                                                                                                                       |
| `REDIS_URL`                                               | api, worker | Redis 6.2+ with `maxmemory-policy noeviction` (required by BullMQ)                                                                                                                                                   |
| `SECRETS_ENCRYPTION_KEY`                                  | api, worker | 32-byte key (hex or base64) encrypting webhook secrets at rest. Required in production; both services must use the same key. Back it up: without it, stored webhook secrets cannot be read (rotate them to recover). |
| `ADMIN_API_TOKEN`                                         | api         | Bootstrap token, ≥ 24 characters in production. Create named tokens in Settings and keep this one for break-glass access.                                                                                            |
| `TESTNET_RPC_URL`, `MAINNET_RPC_URL`, `FUTURENET_RPC_URL` | api, worker | Defaults exist for testnet and futurenet. Can also be changed at runtime in Settings (picked up by the worker within 30 s).                                                                                          |
| `API_URL`                                                 | web         | Where the dashboard server reaches the API                                                                                                                                                                           |
| `SESSION_COOKIE_SECURE`                                   | web         | `true` behind HTTPS                                                                                                                                                                                                  |
| `TRUST_PROXY`                                             | api         | `true` behind a reverse proxy, so rate limiting sees client IPs                                                                                                                                                      |
| `RATE_LIMIT_PER_MINUTE`                                   | api         | Per client IP, default 600; shared across replicas through Redis                                                                                                                                                     |
| `METRICS_TOKEN`                                           | api         | Protects `/metrics`                                                                                                                                                                                                  |
| `INITIAL_LOOKBACK_LEDGERS`                                | api         | History to backfill on registration (default ~1 day)                                                                                                                                                                 |
| `INGEST_INTERVAL_MS`, `INGEST_CONCURRENCY`                | worker      | Poll frequency (default 10 s) and parallel ingestion jobs per worker                                                                                                                                                 |
| `INGEST_BATCH_SIZE`, `INGEST_BATCH_MAX_LAG_LEDGERS`       | worker      | Caught-up contracts polled per RPC call (default 25, the maximum) and how far behind a contract may be to join a batch                                                                                               |
| `EVENT_RETENTION_DAYS`                                    | worker      | Prune stored events after N days (0 = keep forever)                                                                                                                                                                  |
| `AUDIT_LOG_RETENTION_DAYS`                                | worker      | Prune audit log entries after N days (default 365, 0 = keep forever)                                                                                                                                                 |
| `WEBHOOK_BLOCK_PRIVATE_IPS`                               | worker      | Refuse webhooks to private/loopback addresses. Enable in production.                                                                                                                                                 |
| `WEBHOOK_TIMEOUT_MS`, `WEBHOOK_MAX_ATTEMPTS`              | worker      | Delivery timeout and retry count                                                                                                                                                                                     |
| `SMTP_*`                                                  | worker      | Enables email destinations; leave `SMTP_HOST` empty to disable                                                                                                                                                       |

## Scaling

- **API** is stateless: run as many replicas as needed behind a load balancer.
- **Worker** replicas share the queues. Recurring schedules are registered idempotently and
  per-contract jobs are de-duplicated, so running two or more workers gives you redundancy and
  throughput without double processing. Raise `INGEST_CONCURRENCY` before adding replicas.
- **RPC load**: caught-up contracts are polled 25 per `getEvents` call, so 1,000 contracts cost
  about 40 calls per interval. Contracts that are catching up are polled individually. For very
  large fleets use a dedicated RPC provider or raise `INGEST_INTERVAL_MS`.

## Monitoring

Both the API (`/metrics`) and the worker (`:4001/metrics`) expose Prometheus metrics. Useful
alerts:

| Metric                                                           | Alert when                                     |
| ---------------------------------------------------------------- | ---------------------------------------------- |
| `schm_ingestion_lag_ledgers_max`                                 | > 100 for 5 minutes (ingestion falling behind) |
| `rate(schm_ingest_runs_total{result="error"}[5m])`               | sustained errors (RPC problems)                |
| `schm_ingestion_gaps_total`                                      | increases (events were lost to RPC retention)  |
| `rate(schm_notification_deliveries_total{result="failed"}[15m])` | > 0                                            |
| `schm_queue_jobs{state="waiting"}`                               | growing steadily                               |

The dashboard's status indicator and **Settings → System status** show the same signals, and
the worker records a heartbeat every 15 s (`GET /status` → `workerHealthy`).

## Access

Sign in with the bootstrap `ADMIN_API_TOKEN` once, then create a named token per person and
integration in **Settings → API tokens** with the least role they need (`VIEWER`, `EDITOR` or
`ADMIN`). Store the bootstrap token somewhere safe for break-glass access. **Settings → Audit log**
shows every change and who made it.

## Backups

Back up PostgreSQL (`pg_dump` or your provider's snapshots). Redis holds only queued jobs; losing
it delays notifications that were in flight but loses no events or alerts.

## Upgrading

1. Pull or build the new images.
2. Run the `migrate` job (Compose does this automatically on `up`).
3. Restart API, worker and web. Workers finish in-flight jobs on `SIGTERM`.
