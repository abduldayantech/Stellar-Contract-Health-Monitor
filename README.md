# Stellar Contract Health Monitor

A monitoring service for Stellar (Soroban) smart contracts. Register a deployed contract and the
platform keeps track of its events, its storage TTLs and its activity, and notifies you by webhook
or email when something needs attention.

- **Event monitoring** – every event the contract emits is stored, searchable by topic,
  transaction, time and contract.
- **Storage expiry** – the contract instance, its WASM code and any storage keys you choose are
  checked against their TTL (`liveUntilLedger`) so you can extend them before they are archived.
- **Alerts** – rules for matching events (with count thresholds), storage about to expire, and
  contracts that have gone quiet. Notifications go to signed webhooks or email, with retries and
  a full delivery history.
- **Operational visibility** – health checks, Prometheus metrics, ingestion lag and gap detection.
- **Built to scale and secure** – caught-up contracts are polled 25 per RPC call, role-based API
  tokens (viewer / editor / admin), an audit log of every change, webhook secrets encrypted at
  rest, and rate limiting shared across replicas.

No custom smart contract is required: everything is read from Stellar RPC.

## Quick start (local development)

Requirements: Node.js 22, pnpm 10, Docker.

```bash
pnpm install
cp .env.example .env              # set ADMIN_API_TOKEN to a long random string
pnpm services:up                  # Postgres + Redis
pnpm db:deploy                    # apply database migrations
pnpm dev                          # API :4000, worker :4001, dashboard :3000
```

Open http://localhost:3000 and sign in with your `ADMIN_API_TOKEN`.

### Try it on testnet

1. **Add contract** → paste a testnet contract ID (for example the native XLM asset contract
   `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC`) → **Validate** → **Start monitoring**.
2. Invoke the contract (or wait – the XLM contract is busy) and the events appear within seconds
   on the contract page and in the **Events** explorer.
3. To see a notification, run the bundled receiver and add it as a webhook destination:

   ```bash
   node scripts/webhook-receiver.mjs 4100     # prints and verifies incoming webhooks
   ```

   In **Alert rules**, add a webhook destination `http://localhost:4100/hook` (copy its secret
   into `WEBHOOK_SECRET` for the receiver if you want signatures verified), then create an
   _Event match_ rule for topic `transfer`.

## Production

```bash
cp .env.example .env    # set ADMIN_API_TOKEN, SECRETS_ENCRYPTION_KEY, POSTGRES_PASSWORD
                        # (and MAINNET_RPC_URL for mainnet)
docker compose up -d --build
```

See [docs/deployment.md](docs/deployment.md) for configuration, scaling, security and
monitoring guidance.

## Repository layout

```
apps/
  web/            Next.js dashboard (Tailwind)
  api/            Fastify REST API: contract registry, rules, destinations, settings
  worker/         BullMQ workers: event ingestion, TTL checks, inactivity checks, notifications
packages/
  stellar-client/ Stellar RPC wrapper: retries, error classification, contract ID validation
  alert-engine/   Pure alert-rule evaluation, alert text, webhook signing
  shared-types/   Zod schemas and types shared by every app
  db/             Prisma schema, migrations and client
  ui/             Shared React components
tests/e2e/        Playwright end-to-end tests
docs/             Architecture, API, webhook and deployment docs
docker/           Production Dockerfile (api, worker and web targets)
```

## Testing

| Command                       | What it runs                                                   |
| ----------------------------- | -------------------------------------------------------------- |
| `pnpm test`                   | Unit tests (Vitest) for every package                          |
| `pnpm test:integration`       | API and worker against a real Postgres (`schm_test` database)  |
| `pnpm test:e2e`               | Playwright against the real API and dashboard with seeded data |
| `E2E_TESTNET=1 pnpm test:e2e` | Also registers a real contract on Stellar testnet              |

Integration and e2e tests need `pnpm services:up`; e2e also needs
`pnpm --filter @stellar-health/web build` and `pnpm exec playwright install chromium`.

## Documentation

- [Architecture](docs/architecture.md) – components, data flow, event retention
- [API reference](docs/api.md) – REST endpoints and authentication
- Interactive API docs – Swagger UI at `/docs` on a running API ([localhost:4000/docs](http://localhost:4000/docs)
  in development), generated from the code; the OpenAPI 3.1 document is at `/openapi.json`
- [Webhooks](docs/webhooks.md) – payload format and signature verification
- [Deployment](docs/deployment.md) – configuration and operations
- [Monitoring](docs/monitoring.md) – Prometheus alerts and Grafana dashboard
- [Contributing](CONTRIBUTING.md)

## License

[MIT](LICENSE)
