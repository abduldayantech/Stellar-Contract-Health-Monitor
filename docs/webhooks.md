# Webhooks

Webhook destinations receive an HTTP `POST` with a JSON body for every alert (and, if enabled in
Settings, when a TTL or inactivity alert resolves itself).

## Payload

```json
{
  "version": 1,
  "deliveryId": "cmv…",
  "type": "alert.triggered",
  "sentAt": "2026-10-26T10:43:37.000Z",
  "alert": {
    "id": "cmv…",
    "title": "transfer / GAGVZM…LQQX on XLM (CDLZFC…CYSC)",
    "message": "Rule \"Transfers\" matched 1 new event on testnet.",
    "severity": "WARNING",
    "status": "TRIGGERED",
    "triggeredAt": "2026-10-26T10:43:36.000Z",
    "rule": { "id": "…", "name": "Transfers", "type": "EVENT_MATCH" },
    "contract": { "id": "…", "contractId": "CDLZ…", "network": "TESTNET", "label": "XLM" },
    "context": {
      "events": [
        {
          "eventId": "…",
          "ledger": 5397566,
          "txHash": "…",
          "topics": ["transfer", "G…", "G…", "native"]
        }
      ]
    }
  }
}
```

`type` is `alert.triggered`, `alert.resolved` or `test`. `context` depends on the rule type
(matched events, TTL breaches, or idle time). The format is versioned; new fields may be added
without changing `version`.

## Headers

| Header             | Value                                                                               |
| ------------------ | ----------------------------------------------------------------------------------- |
| `x-schm-signature` | `sha256=<hex HMAC-SHA256 of "<timestamp>.<raw body>" using the destination secret>` |
| `x-schm-timestamp` | Unix seconds when the request was signed                                            |
| `x-schm-delivery`  | Delivery ID – the same across retries; use it to de-duplicate                       |

Custom headers configured on the destination are also sent.

## Verifying signatures

Always verify against the **raw** request body and reject old timestamps to prevent replays.

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verify(rawBody, headers, secret, toleranceSeconds = 300) {
  const timestamp = Number(headers['x-schm-timestamp']);
  if (!timestamp || Math.abs(Date.now() / 1000 - timestamp) > toleranceSeconds) return false;
  const expected = Buffer.from(
    `sha256=${createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')}`,
  );
  const actual = Buffer.from(String(headers['x-schm-signature'] ?? ''));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
```

`scripts/webhook-receiver.mjs` is a runnable example receiver.

## Retries

Respond with any `2xx` within `WEBHOOK_TIMEOUT_MS` (default 10 s). Timeouts, connection errors,
`408`, `429` and `5xx` are retried with exponential backoff (10 s, 20 s, 40 s, …) up to
`WEBHOOK_MAX_ATTEMPTS` (default 6). Other responses, including redirects, fail immediately.
Failed deliveries can be retried from **Alert history**.

## Security

- The secret is shown once when the destination is created; rotate it from the Alert rules page.
- With `WEBHOOK_BLOCK_PRIVATE_IPS=true` (the default in `docker-compose.yml`), webhooks to
  loopback, private, link-local and metadata addresses are refused.

## Destinations that keep failing

Each destination counts its failed deliveries in a row (a delivery fails once all retries are
used up; test notifications don't count, and any success resets the count). After
`DESTINATION_DISABLE_AFTER_FAILURES` failures (default 20) spanning at least
`DESTINATION_DISABLE_MIN_HOURS` (default 24), the worker:

1. disables the destination and records why (shown on the destination in the dashboard and as
   `disabledReason` in `GET /destinations`), and
2. raises a **System** alert that is sent to the default destinations from Settings, except the
   one that was disabled.

Fix the receiver, then press **Re-enable** (or `PATCH /destinations/:id` with
`{"enabled": true}`), which also resets the failure count.
