import client from 'prom-client';

export function createWorkerMetrics() {
  const registry = new client.Registry();
  registry.setDefaultLabels({ service: 'worker' });
  client.collectDefaultMetrics({ register: registry });

  return {
    registry,
    eventsIngested: new client.Counter({
      name: 'schm_events_ingested_total',
      help: 'Contract events stored',
      labelNames: ['network'],
      registers: [registry],
    }),
    ingestRuns: new client.Counter({
      name: 'schm_ingest_runs_total',
      help: 'Ingestion runs by result',
      labelNames: ['network', 'result'],
      registers: [registry],
    }),
    ingestDuration: new client.Histogram({
      name: 'schm_ingest_duration_seconds',
      help: 'Duration of a single contract ingestion run',
      labelNames: ['network'],
      buckets: [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
      registers: [registry],
    }),
    ingestionGaps: new client.Counter({
      name: 'schm_ingestion_gaps_total',
      help: 'Times ingestion skipped ledgers that fell outside the RPC retention window',
      labelNames: ['network'],
      registers: [registry],
    }),
    rpcCalls: new client.Counter({
      name: 'schm_rpc_calls_total',
      help: 'Stellar RPC calls',
      labelNames: ['method', 'result', 'provider'],
      registers: [registry],
    }),
    rpcDuration: new client.Histogram({
      name: 'schm_rpc_call_duration_seconds',
      help: 'Stellar RPC call duration (including retries)',
      labelNames: ['method', 'provider'],
      buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
      registers: [registry],
    }),
    rpcFailovers: new client.Counter({
      name: 'schm_rpc_failovers_total',
      help: 'Times calls for a network moved to a different RPC provider',
      labelNames: ['network', 'to'],
      registers: [registry],
    }),
    rpcRetries: new client.Counter({
      name: 'schm_rpc_retries_total',
      help: 'Stellar RPC retries',
      labelNames: ['kind'],
      registers: [registry],
    }),
    alertsTriggered: new client.Counter({
      name: 'schm_alerts_triggered_total',
      help: 'Alerts triggered',
      labelNames: ['type', 'severity'],
      registers: [registry],
    }),
    alertsResolved: new client.Counter({
      name: 'schm_alerts_resolved_total',
      help: 'Alerts auto-resolved',
      labelNames: ['type'],
      registers: [registry],
    }),
    deliveries: new client.Counter({
      name: 'schm_notification_deliveries_total',
      help: 'Notification delivery attempts',
      labelNames: ['type', 'result'],
      registers: [registry],
    }),
    deliveryDuration: new client.Histogram({
      name: 'schm_notification_delivery_duration_seconds',
      help: 'Notification delivery attempt duration',
      labelNames: ['type'],
      buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [registry],
    }),
    queueDepth: new client.Gauge({
      name: 'schm_queue_jobs',
      help: 'Jobs per queue and state',
      labelNames: ['queue', 'state'],
      registers: [registry],
    }),
    maxIngestionLag: new client.Gauge({
      name: 'schm_ingestion_lag_ledgers_max',
      help: 'Largest gap between network latest ledger and a contract’s last ingested ledger',
      labelNames: ['network'],
      registers: [registry],
    }),
  };
}

export type WorkerMetrics = ReturnType<typeof createWorkerMetrics>;
