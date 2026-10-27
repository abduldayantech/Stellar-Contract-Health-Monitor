# API reference

Base URL: the API service (`http://localhost:4000` in development). All request and response
bodies are JSON.

## Authentication

Send a token with every request except `/health`, `/ready` and `/metrics`:

```
Authorization: Bearer <token>        # or: X-API-Key: <token>
```

Tokens are either the bootstrap `ADMIN_API_TOKEN` or named tokens created in **Settings → API
tokens** (`POST /settings/tokens`). Named tokens are stored hashed and shown once.

### Roles

Every named token has a role (default `VIEWER`):

| Role     | Can                                                                                                                                         |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `VIEWER` | Read everything except API tokens and the audit log                                                                                         |
| `EDITOR` | Also register/pause/delete contracts, manage storage entries, alert rules and destinations, acknowledge/resolve alerts and retry deliveries |
| `ADMIN`  | Also change RPC providers and notification preferences, manage API tokens and read the audit log                                            |

The bootstrap token is always `ADMIN`. Requests without the needed role get `403 FORBIDDEN`.
Give each person and integration its own token so the audit log shows who did what.

Named tokens can expire: pass `"expiresInDays": 1-3650` when creating one (omit it, or send
`null`, for a token that never expires). Expired tokens get `401 TOKEN_EXPIRED` ("Token
expired"). The dashboard defaults new tokens to 90 days and highlights tokens that expire
within a week.

### Audit log

Every state-changing request (`POST`, `PUT`, `PATCH`, `DELETE`) is recorded with the token name,
route, path, status code and client IP, including requests denied with `403`. Request bodies are
never stored. Read it with `GET /audit-log` (admins only) or in **Settings → Audit log**.

## Errors

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "txHash: txHash must be 64 hex characters",
    "details": []
  }
}
```

| Status | Codes                                                                                           |
| ------ | ----------------------------------------------------------------------------------------------- |
| 400    | `VALIDATION_ERROR`, `INVALID_CONTRACT_ID`, `INVALID_JSON`, `INVALID_DESTINATION`, `INVALID_KEY` |
| 401    | `UNAUTHORIZED`, `TOKEN_EXPIRED`                                                                 |
| 403    | `FORBIDDEN` – the token's role does not allow this                                              |
| 404    | `NOT_FOUND`                                                                                     |
| 409    | `ALREADY_REGISTERED`, `INVALID_STATE`, `CONFLICT`                                               |
| 422    | `CONTRACT_NOT_FOUND`, `NETWORK_NOT_CONFIGURED`, `RPC_UNREACHABLE`, `NETWORK_MISMATCH`           |
| 429    | rate limited (`RATE_LIMIT_PER_MINUTE` per client IP, default 600, shared across replicas)       |
| 502    | `RPC_ERROR` – the Stellar RPC failed                                                            |

## Pagination

List endpoints for events and alerts return `{ "items": [...], "nextCursor": "..." | null }`.
Pass `cursor=<nextCursor>` to get the next page; `limit` is 1–200 (default 50).

## Endpoints

### Status

| Method | Path       | Description                                                                 |
| ------ | ---------- | --------------------------------------------------------------------------- |
| GET    | `/health`  | Liveness (public)                                                           |
| GET    | `/ready`   | Database and Redis reachability (public; 503 when degraded)                 |
| GET    | `/metrics` | Prometheus metrics (public, or `Bearer METRICS_TOKEN` if set)               |
| GET    | `/status`  | Dashboard status: dependencies, queues, worker heartbeats, networks, totals |
| GET    | `/auth/me` | The current principal                                                       |

### Contracts

| Method | Path                                      | Description                                                                           |
| ------ | ----------------------------------------- | ------------------------------------------------------------------------------------- |
| POST   | `/contracts/validate`                     | `{contractId, network}` – checks format and that the contract exists on chain         |
| POST   | `/contracts`                              | `{contractId, network, label?, lookbackLedgers?}` – register and start monitoring     |
| GET    | `/contracts`                              | `?network&status&search`                                                              |
| GET    | `/contracts/:id`                          | Details, storage entries with TTLs, rules, recent alerts                              |
| GET    | `/contracts/:id/activity`                 | `?hours=24` – event counts per hour (per day above 72 h)                              |
| PATCH  | `/contracts/:id`                          | `{label?, status?: ACTIVE\|PAUSED}`                                                   |
| DELETE | `/contracts/:id`                          | Stop monitoring and delete stored data                                                |
| POST   | `/contracts/:id/refresh`                  | Queue ingestion and a TTL check now                                                   |
| POST   | `/contracts/:id/storage-entries`          | `{label, durability: PERSISTENT\|TEMPORARY, keyType: symbol\|enum_variant\|xdr, key}` |
| DELETE | `/contracts/:id/storage-entries/:entryId` | Stop monitoring a storage key                                                         |

Each storage entry in `GET /contracts/:id` has an `extend` field describing how to pass it to
`stellar contract extend`: `{kind: "instance"}`, `{kind: "code", wasmHash}` or
`{kind: "data", durability, key: {symbol} | {xdr}}`. The dashboard turns it into a copyable
command, and TTL alerts include the same command for entries that are still live.

### Events

| Method | Path             | Description                                                                                 |
| ------ | ---------------- | ------------------------------------------------------------------------------------------- |
| GET    | `/events`        | `?contractRefId&contractId&network&topic&txHash&type&from&to&limit&cursor` – newest first   |
| GET    | `/events/export` | Same filters plus `format=csv\|ndjson`; streams up to 100,000 matching events as a download |
| GET    | `/events/topics` | `?contractRefId` – most common first topics                                                 |
| GET    | `/events/:id`    | One event with decoded value and raw XDR                                                    |

### Alert rules and destinations

| Method               | Path                              | Description                                                                                                           |
| -------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| GET / POST           | `/alert-rules`                    | List (`?contractRefId`) / create                                                                                      |
| GET / PATCH / DELETE | `/alert-rules/:id`                | Read / update / delete                                                                                                |
| GET / POST           | `/destinations`                   | List with 7-day delivery stats / create (webhook secret returned once); types in [notifications.md](notifications.md) |
| PATCH / DELETE       | `/destinations/:id`               | Update / delete                                                                                                       |
| POST                 | `/destinations/:id/rotate-secret` | New webhook secret (returned once)                                                                                    |
| POST                 | `/destinations/:id/test`          | Queue a test notification                                                                                             |
| GET                  | `/destinations/:id/deliveries`    | Last 50 deliveries                                                                                                    |

Rule body:

```json
{
  "name": "Large transfers",
  "type": "EVENT_MATCH",
  "contractRefId": "<contract id or null for all contracts>",
  "severity": "WARNING",
  "cooldownSeconds": 300,
  "destinationIds": ["<destination id>"],
  "config": { "topics": ["transfer", "*", "**"], "threshold": 1, "windowSeconds": 300 }
}
```

`TTL_EXPIRY` config: `{ "ledgersThreshold": 120960 }`. `INACTIVITY` config: `{ "windowSeconds": 86400 }`.

### Alerts

| Method | Path                      | Description                                                  |
| ------ | ------------------------- | ------------------------------------------------------------ |
| GET    | `/alerts`                 | `?status&contractRefId&ruleId&deliveryStatus&limit&cursor`   |
| GET    | `/alerts/summary`         | Counts by status and failed deliveries                       |
| GET    | `/alerts/:id`             | One alert with its deliveries                                |
| POST   | `/alerts/:id/acknowledge` | `TRIGGERED` → `ACKNOWLEDGED`                                 |
| POST   | `/alerts/:id/resolve`     | Resolve (level rules can fire again if the condition recurs) |
| POST   | `/deliveries/:id/retry`   | Retry a failed delivery                                      |

### Settings

| Method     | Path                          | Description                                                        |
| ---------- | ----------------------------- | ------------------------------------------------------------------ |
| GET        | `/settings/networks`          | RPC provider per network and its source (env, database, default)   |
| PUT        | `/settings/networks/:network` | `{rpcUrl, networkPassphrase?, enabled?}` – probed before saving    |
| DELETE     | `/settings/networks/:network` | Revert to the environment/default                                  |
| POST       | `/settings/networks/test`     | `{rpcUrl}` – probe without saving                                  |
| GET / POST | `/settings/tokens`            | List / create API tokens (`{name, role}`)                          |
| DELETE     | `/settings/tokens/:id`        | Revoke                                                             |
| GET / PUT  | `/settings/notifications`     | `{defaultCooldownSeconds, defaultDestinationIds, notifyOnResolve}` |
| GET        | `/audit-log`                  | `?actorId&method&limit&cursor` – newest first                      |

## Example

```bash
T="Authorization: Bearer $ADMIN_API_TOKEN"
curl -s -X POST localhost:4000/contracts -H "$T" -H 'content-type: application/json' \
  -d '{"contractId":"CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC","network":"TESTNET","label":"XLM"}'
curl -s "localhost:4000/events?topic=transfer&limit=5" -H "$T"
```
