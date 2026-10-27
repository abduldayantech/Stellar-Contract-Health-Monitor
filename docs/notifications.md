# Notification destinations

Alert rules send notifications to one or more destinations. Create them on **Alerts → Rules →
Add destination**, or with `POST /destinations`. Every destination has a **Send test** button
(`POST /destinations/:id/test`) and a delivery history.

| Type      | Config                       | Notes                                                          |
| --------- | ---------------------------- | -------------------------------------------------------------- |
| `WEBHOOK` | `{ url, secret?, headers? }` | Signed JSON payload, see [webhooks.md](webhooks.md)            |
| `EMAIL`   | `{ to: string[] }`           | Needs `SMTP_HOST` on the worker                                |
| `SLACK`   | `{ webhookUrl }`             | Slack incoming webhook on `https://hooks.slack.com/...`        |
| `DISCORD` | `{ webhookUrl }`             | Discord channel webhook `https://discord.com/api/webhooks/...` |
| `TEAMS`   | `{ webhookUrl }`             | Teams incoming webhook or Workflows (Power Automate) URL       |

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
signing secrets and header values, and chat webhook URLs. The API never returns them in full
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
