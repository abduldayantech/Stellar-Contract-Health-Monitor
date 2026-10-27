# Monitoring

The API (`:4000/metrics`) and worker (`:4001/metrics`) export Prometheus metrics. This repository
ships alert rules and a Grafana dashboard for them.

## Quick start

```bash
GRAFANA_ADMIN_PASSWORD=change-me docker compose -f docker-compose.yml -f docker-compose.monitoring.yml up -d
```

Open Grafana on http://localhost:3001 (user `admin`). The **Stellar → Stellar Contract Health
Monitor** dashboard and the Prometheus datasource are provisioned automatically.

If `METRICS_TOKEN` is set on the API, add it to the API job in
[`deploy/prometheus/prometheus.yml`](../deploy/prometheus/prometheus.yml).

## Using your own Prometheus and Grafana

- Scrape `api:4000/metrics` as job `stellar-health-api` and `worker:4001/metrics` as job
  `stellar-health-worker` (the `StellarHealthWorkerDown` rule uses that job name).
- Load [`deploy/prometheus/alerts.yml`](../deploy/prometheus/alerts.yml) as a rule file.
  Validate changes with `promtool check rules deploy/prometheus/alerts.yml`.
- Import [`deploy/grafana/stellar-health.json`](../deploy/grafana/stellar-health.json) in Grafana
  (Dashboards → New → Import) and pick your Prometheus datasource.

## Alerts

| Alert                               | Fires when                                                                 | Severity |
| ----------------------------------- | -------------------------------------------------------------------------- | -------- |
| `StellarHealthIngestionLagging`     | A network's slowest contract is more than 100 ledgers behind for 5 minutes | warning  |
| `StellarHealthIngestErrors`         | More than 3 failed ingestion runs per minute for 10 minutes                | warning  |
| `StellarHealthIngestionGap`         | Events were lost because the RPC no longer retained them                   | critical |
| `StellarHealthNotificationsFailing` | A notification exhausted its retries in the last 15 minutes                | warning  |
| `StellarHealthQueueBacklog`         | More than 500 jobs waiting in a queue for 15 minutes                       | warning  |
| `StellarHealthWorkerDown`           | No worker has been scraped for 2 minutes                                   | critical |
| `StellarHealthApiErrors`            | More than 5% of API requests return 5xx for 5 minutes                      | warning  |
| `StellarHealthRpcSlow`              | RPC p95 latency above 5 s for 10 minutes                                   | info     |

## Dashboard panels

Ingestion lag, events per minute, alerts and failed notifications at a glance; then ingestion
runs and duration, RPC latency, calls and retries, notification results, queue depth, and API
request rate and latency by route.
