# Notification destinations

Alert rules send notifications to one or more destinations. Create them on **Alerts → Rules →
Add destination**, or with `POST /destinations`. Every destination has a **Send test** button
(`POST /destinations/:id/test`) and a delivery history.

| Type        | Config                       | Notes                                                            |
| ----------- | ---------------------------- | ---------------------------------------------------------------- |
| `WEBHOOK`   | `{ url, secret?, headers? }` | Signed JSON payload, see [webhooks.md](webhooks.md)              |
| `EMAIL`     | `{ to: string[] }`           | Needs `SMTP_HOST` on the worker                                  |
| `SLACK`     | `{ webhookUrl }`             | Slack incoming webhook on `https://hooks.slack.com/...`          |
| `DISCORD`   | `{ webhookUrl }`             | Discord channel webhook `https://discord.com/api/webhooks/...`   |
| `TEAMS`     | `{ webhookUrl }`             | Teams incoming webhook or Workflows (Power Automate) URL         |
| `TELEGRAM`  | `{ botToken, chatId }`       | Telegram bot; the token is never returned by the API             |
| `PAGERDUTY` | `{ routingKey, region? }`    | Opens incidents and resolves them; key never returned by the API |

## Delivery and retries

Every destination type follows the same rules:

- `2xx` responses mark the delivery **succeeded**.
- `408`, `429` and `5xx` responses, network errors and timeouts are retried with exponential
  backoff (10s, 20s, 40s…, up to 6 attempts). When the destination sends a `Retry-After` header
  or a Discord `retry_after` value, the next attempt waits at least that long.
- Other `4xx` responses and redirects fail the delivery straight away; they need a config fix.

Failed deliveries can be retried from **Alerts → History**.

## Credentials at rest

Credential fields are encrypted with AES-256-GCM when `SECRETS_ENCRYPTION_KEY` is set: webhook
signing secrets and header values, chat webhook URLs, Telegram bot tokens and PagerDuty routing keys. The API never returns them in full
after creation: chat webhook URLs are shown masked, e.g. `https://hooks.slack.com/…a1b2`.

## Slack

1. In Slack, create an app with **Incoming Webhooks** enabled and add a webhook to the channel
   that should receive alerts (see Slack's
   [incoming webhooks guide](https://api.slack.com/messaging/webhooks)).
2. Copy the webhook URL (`https://hooks.slack.com/services/...`).
3. In the dashboard, add a destination of type **Slack** with that URL, then press **Send test**.

```bash
curl -X POST "$API/destinations" -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"type":"SLACK","name":"#ops-alerts","config":{"webhookUrl":"https://hooks.slack.com/services/T000/B000/XXXX"}}'
```

Messages use Block Kit: a header with the severity and title, the alert message, a context line
with severity, contract and trigger time, and a **View in dashboard** button that links to
`PUBLIC_DASHBOARD_URL/alerts/history?alert=<id>`. Set `PUBLIC_DASHBOARD_URL` on the worker so the
link points at your dashboard.

## Discord

1. In Discord, open **Server settings → Integrations → Webhooks**, create a webhook for the
   alerts channel and copy its URL (`https://discord.com/api/webhooks/<id>/<token>`).
2. Add a destination of type **Discord** with that URL, then press **Send test**.

Each alert is one embed coloured by severity (info blue, warning amber, critical red, resolved
green) with the severity, contract and a link to the alert in the dashboard. Mentions are
disabled, so alert text can never ping `@everyone` or a role.

## Microsoft Teams

Teams accepts an Adaptive Card through either:

- a **Workflows** flow ("Post to a channel when a webhook request is received"), whose URL is on
  `*.logic.azure.com` or `*.environment.api.powerplatform.com`, or
- a classic **Incoming Webhook** connector URL on `*.webhook.office.com`.

Copy the URL, add a destination of type **Microsoft Teams**, then press **Send test**. The card
shows the title (coloured by severity), the message, a fact list with severity, contract and
trigger time, and a **View in dashboard** button.

## Telegram

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy its token
   (`123456789:AA…`).
2. Add the bot to the group or channel that should receive alerts (as an admin for channels).
3. Find the chat ID: send a message in the chat and open
   `https://api.telegram.org/bot<token>/getUpdates`; group and channel IDs are negative numbers
   such as `-1001234567890`. Public channels can also use their `@username`.
4. Add a destination of type **Telegram** with the token and chat ID, then press **Send test**.

Messages use HTML parse mode with all alert text escaped, and stay within Telegram's 4096
character limit. The bot token is encrypted at rest and never returned by the API; the
dashboard only shows the chat ID. Telegram `429` responses are retried after the
`retry_after` it asks for.

## PagerDuty

1. In PagerDuty, open the service that should be paged, go to **Integrations → Add an
   integration** and choose **Events API v2**. Copy its 32-character **Integration Key**.
2. Add a destination of type **PagerDuty** with that key. Choose the **EU** region if your account
   is hosted at `*.eu.pagerduty.com`.
3. Press **Send test**: it opens an `info` incident and resolves it straight away, so nobody stays
   paged.

How alerts map onto PagerDuty events:

| Alert                                    | Event                                            |
| ---------------------------------------- | ------------------------------------------------ |
| triggered                                | `trigger`, `dedup_key` = `schm-alert-<alert id>` |
| resolved (TTL or inactivity recovered)   | `resolve` with the same `dedup_key`              |
| resolved by hand in the dashboard / API  | `resolve` with the same `dedup_key`              |
| severity `INFO` / `WARNING` / `CRITICAL` | `info` / `warning` / `critical`                  |

Resolves are always sent to PagerDuty destinations that received the trigger, whatever the
**Notify on resolve** preference, so incidents close when the condition clears. The event's
`source` is `<network>:<contract ID>`, `component` the contract label, `group` and `class` the
rule name and type, and `custom_details` carries the message, contract, rule and alert context. A
link opens the alert in the dashboard (set `PUBLIC_DASHBOARD_URL`).

The routing key is encrypted at rest and never returned by the API; the dashboard only shows the
region. PagerDuty `429` and `5xx` responses are retried like any other destination.
