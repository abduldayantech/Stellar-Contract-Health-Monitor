import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { verifyWebhookSignature } from '@stellar-health/alert-engine';
import {
  disconnectPrisma,
  getPrisma,
  sealDestinationConfig,
  type Prisma,
} from '@stellar-health/db';
import { resetDatabase } from '../../../../tests/support/test-db';
import { deliverNotification } from '../../src/delivery';
import { checkInactivity } from '../../src/inactivity';
import { ingestBatch, ingestContract } from '../../src/ingest';
import { encryptLegacySecrets, pruneOldData } from '../../src/maintenance';
import { checkStorage } from '../../src/storage';
import { createContract, createHarness, type Harness } from './helpers';

const prisma = getPrisma();
const past = (ms: number) => new Date(Date.now() - ms);
let h: Harness;

beforeEach(async () => {
  await resetDatabase(prisma);
  h = createHarness();
});
afterAll(async () => {
  await disconnectPrisma();
});

async function webhookDestination(url: string, secret = 'whsec_test_secret_0123456789') {
  return prisma.notificationDestination.create({
    data: { name: 'hook', type: 'WEBHOOK', config: { url, secret } },
  });
}

describe('event ingestion', () => {
  it('stores events across pages, persists the cursor and does not re-insert on the next poll', async () => {
    const c = await createContract(1, { startLedger: 600 });
    for (let i = 0; i < 12; i++) h.rpc.emit(c.contractId, 700 + i, ['transfer', 'GA', 'GB']);
    h.rpc.emit('COTHER', 705, ['transfer']);

    const first = await ingestContract(h.deps, c.id);
    expect(first).toMatchObject({ inserted: 12, pages: 3, gap: false });
    const row = await prisma.contract.findUniqueOrThrow({ where: { id: c.id } });
    expect(row.cursor).toBeTruthy();
    expect(row.eventCount).toBe(12);
    expect(row.lastIngestedLedger).toBe(1000);
    expect(await prisma.networkState.findUnique({ where: { network: 'TESTNET' } })).toMatchObject({
      latestLedger: 1000,
    });

    h.rpc.emit(c.contractId, 1001, ['mint']);
    const second = await ingestContract(h.deps, c.id);
    expect(second.inserted).toBe(1);
    expect(h.rpc.calls.at(-1)).toHaveProperty('cursor');
    expect(await prisma.event.count({ where: { contractRefId: c.id } })).toBe(13);
  });

  it('records how far it got, not the RPC tip, when the page budget runs out', async () => {
    h = createHarness({ INGEST_MAX_PAGES: '2' });
    const c = await createContract(3, { startLedger: 600 });
    for (let i = 0; i < 20; i++) h.rpc.emit(c.contractId, 700 + i, ['transfer']);

    // 2 pages of 5 events: ledgers 700-709 stored, ledger 709 may continue on the next page.
    expect(await ingestContract(h.deps, c.id)).toMatchObject({ inserted: 10 });
    let row = await prisma.contract.findUniqueOrThrow({ where: { id: c.id } });
    expect(row.lastIngestedLedger).toBe(708);

    expect(await ingestContract(h.deps, c.id)).toMatchObject({ inserted: 10 });
    row = await prisma.contract.findUniqueOrThrow({ where: { id: c.id } });
    // Ledger 719 filled the last page exactly, so the tip is confirmed on the next poll.
    expect(row.lastIngestedLedger).toBe(718);
    await ingestContract(h.deps, c.id);
    row = await prisma.contract.findUniqueOrThrow({ where: { id: c.id } });
    expect(row.lastIngestedLedger).toBe(1000);
    expect(row.eventCount).toBe(20);
  });

  it('clamps a stale start ledger to the retention window and records a gap when history was lost', async () => {
    const c = await createContract(2, { startLedger: 100 });
    h.rpc.emit(c.contractId, 800, ['x']);
    const fresh = await ingestContract(h.deps, c.id);
    // First ever poll: starting late is expected, not a gap.
    expect(fresh).toMatchObject({ inserted: 1, gap: false });

    // Simulate the worker being down long enough for the cursor to fall out of retention.
    h.rpc.health.oldestLedger = 2000;
    h.rpc.health.latestLedger = 2500;
    h.rpc.emit(c.contractId, 2100, ['y']);
    const resumed = await ingestContract(h.deps, c.id);
    expect(resumed).toMatchObject({ inserted: 1, gap: true });
    const row = await prisma.contract.findUniqueOrThrow({ where: { id: c.id } });
    expect(row.gapDetectedAt).not.toBeNull();
  });

  it('records failures on the contract and skips paused contracts', async () => {
    const c = await createContract(3);
    h.deps.getClient = async () => {
      throw new Error('rpc down');
    };
    await expect(ingestContract(h.deps, c.id)).rejects.toThrow('rpc down');
    expect(await prisma.contract.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({
      consecutiveFailures: 1,
      lastError: 'rpc down',
    });

    await prisma.contract.update({ where: { id: c.id }, data: { status: 'PAUSED' } });
    expect((await ingestContract(h.deps, c.id)).skipped).toBe('not_active');
    expect((await ingestContract(h.deps, 'missing')).skipped).toBe('not_found');
  });
});

describe('batched ingestion', () => {
  it('polls several contracts with one RPC stream and attributes events correctly', async () => {
    const a = await createContract(50, { createdAt: past(3600_000) });
    const b = await createContract(51, { createdAt: past(3600_000) });
    await prisma.alertRule.create({
      data: {
        name: 'B mints',
        type: 'EVENT_MATCH',
        contractRefId: b.id,
        config: { topics: ['mint'] },
        createdAt: past(3600_000),
      },
    });
    h.rpc.emit(a.contractId, 700, ['init']);
    h.rpc.emit(b.contractId, 700, ['init']);
    await ingestContract(h.deps, a.id);
    await ingestContract(h.deps, b.id);

    h.rpc.emit(a.contractId, 1001, ['transfer']);
    h.rpc.emit(b.contractId, 1002, ['mint']);
    h.rpc.emit(a.contractId, 1003, ['transfer']);
    const callsBefore = h.rpc.calls.length;
    const result = await ingestBatch(h.deps, [a.id, b.id]);

    expect(result).toMatchObject({ contracts: 2, inserted: 3 });
    expect(h.rpc.calls.length - callsBefore).toBe(1);
    expect(h.rpc.calls.at(-1)!.contractIds.sort()).toEqual([a.contractId, b.contractId].sort());
    expect(await prisma.event.count({ where: { contractRefId: a.id } })).toBe(3);
    expect(await prisma.event.count({ where: { contractRefId: b.id } })).toBe(2);
    const [ra, rb] = await Promise.all([
      prisma.contract.findUniqueOrThrow({ where: { id: a.id } }),
      prisma.contract.findUniqueOrThrow({ where: { id: b.id } }),
    ]);
    expect(ra.cursor).toBe(rb.cursor);
    expect(ra.eventCount).toBe(3);
    expect(rb.eventCount).toBe(2);
    // Only contract B's rule fired, for B's mint.
    const alerts = await prisma.alert.findMany();
    expect(alerts.map((x) => x.contractRefId)).toEqual([b.id]);

    // Nothing is re-inserted on the next batch.
    expect((await ingestBatch(h.deps, [a.id, b.id])).inserted).toBe(0);
  });

  it('falls back to per-contract ingestion when the batch cursor is out of retention', async () => {
    const a = await createContract(52);
    const b = await createContract(53);
    h.rpc.emit(a.contractId, 700, ['x']);
    h.rpc.emit(b.contractId, 700, ['x']);
    await ingestContract(h.deps, a.id);
    await ingestContract(h.deps, b.id);
    h.rpc.health.oldestLedger = 2000;
    h.rpc.health.latestLedger = 2500;
    h.rpc.emit(a.contractId, 2100, ['y']);
    const result = await ingestBatch(h.deps, [a.id, b.id]);
    expect(result.fallback).toBe('retention');
    const rows = await prisma.contract.findMany({ where: { id: { in: [a.id, b.id] } } });
    expect(rows.every((r) => r.gapDetectedAt !== null)).toBe(true);
    expect(await prisma.event.count({ where: { contractRefId: a.id } })).toBe(2);
  });

  it('records the failure on every contract in the batch', async () => {
    const a = await createContract(54);
    const b = await createContract(55);
    await prisma.contract.updateMany({ data: { cursor: '0000000000000000700-0000000000' } });
    h.rpc.getEvents = async () => {
      throw new Error('rpc exploded');
    };
    await expect(ingestBatch(h.deps, [a.id, b.id])).rejects.toThrow('rpc exploded');
    const rows = await prisma.contract.findMany();
    expect(rows.map((r) => r.consecutiveFailures)).toEqual([1, 1]);
  });
});

describe('event alert rules', () => {
  it('triggers on matching new events, queues deliveries and respects cooldown', async () => {
    const c = await createContract(10, { createdAt: past(3600_000) });
    const d = await webhookDestination('https://example.com/hook');
    await prisma.alertRule.create({
      data: {
        name: 'Transfers',
        type: 'EVENT_MATCH',
        contractRefId: c.id,
        cooldownSeconds: 600,
        config: { topics: ['transfer', '**'] },
        destinations: { connect: [{ id: d.id }] },
        createdAt: past(3600_000),
      },
    });
    h.rpc.emit(c.contractId, 700, ['mint']);
    await ingestContract(h.deps, c.id);
    expect(await prisma.alert.count()).toBe(0);

    h.rpc.emit(c.contractId, 701, ['transfer', 'GA']);
    await ingestContract(h.deps, c.id);
    const alerts = await prisma.alert.findMany({ include: { deliveries: true } });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.deliveries).toHaveLength(1);
    expect(h.queued).toEqual([alerts[0]!.deliveries[0]!.id]);

    h.rpc.emit(c.contractId, 702, ['transfer', 'GB']);
    await ingestContract(h.deps, c.id);
    expect(await prisma.alert.count()).toBe(1);
  });

  it('only alerts on events whose value passes the numeric condition', async () => {
    const c = await createContract(12, { createdAt: past(3600_000) });
    await prisma.alertRule.create({
      data: {
        name: 'Large transfers',
        type: 'EVENT_MATCH',
        contractRefId: c.id,
        cooldownSeconds: 0,
        config: {
          topics: ['transfer', '**'],
          valueCondition: { path: 'amount', op: 'gte', value: '10000000000000000000' },
        },
        createdAt: past(3600_000),
      },
    });
    h.rpc.emit(c.contractId, 700, ['transfer']).value = { amount: '9999999999999999999' };
    await ingestContract(h.deps, c.id);
    expect(await prisma.alert.count()).toBe(0);

    h.rpc.emit(c.contractId, 701, ['transfer']).value = { amount: '10000000000000000000' };
    await ingestContract(h.deps, c.id);
    expect(await prisma.alert.count()).toBe(1);
  });

  it('does not alert on events backfilled from before the rule existed', async () => {
    const c = await createContract(11);
    await prisma.alertRule.create({ data: { name: 'Any', type: 'EVENT_MATCH', config: {} } });
    h.rpc.emit(c.contractId, 700, ['old'], past(3 * 3600_000));
    await ingestContract(h.deps, c.id);
    expect(await prisma.event.count()).toBe(1);
    expect(await prisma.alert.count()).toBe(0);
  });

  it('honours count thresholds within a window', async () => {
    const c = await createContract(12, { createdAt: past(3600_000) });
    await prisma.alertRule.create({
      data: {
        name: 'Burst',
        type: 'EVENT_MATCH',
        config: { threshold: 3, windowSeconds: 300 },
        createdAt: past(3600_000),
      },
    });
    h.rpc.emit(c.contractId, 700, ['a']);
    h.rpc.emit(c.contractId, 701, ['a']);
    await ingestContract(h.deps, c.id);
    expect(await prisma.alert.count()).toBe(0);
    h.rpc.emit(c.contractId, 702, ['a']);
    await ingestContract(h.deps, c.id);
    expect(await prisma.alert.count()).toBe(1);
  });
});

describe('storage TTL and inactivity rules', () => {
  it('opens one alert while an entry is near expiry and resolves it once extended', async () => {
    const c = await createContract(20);
    await prisma.storageEntry.create({
      data: { contractRefId: c.id, kind: 'INSTANCE', label: 'Instance', ledgerKeyXdr: 'key-1' },
    });
    await prisma.alertRule.create({
      data: {
        name: 'TTL',
        type: 'TTL_EXPIRY',
        cooldownSeconds: 0,
        config: { ledgersThreshold: 1000 },
      },
    });
    h.rpc.ttls.set('key-1', {
      ledgerKeyXdr: 'key-1',
      exists: true,
      liveUntilLedger: 1500,
      lastModifiedLedger: 1,
    });

    await checkStorage(h.deps, c.id);
    await checkStorage(h.deps, c.id);
    const open = await prisma.alert.findMany();
    expect(open).toHaveLength(1);
    expect(open[0]!.status).toBe('TRIGGERED');
    expect(await prisma.storageEntry.findFirstOrThrow()).toMatchObject({
      exists: true,
      liveUntilLedger: 1500,
    });

    h.rpc.ttls.set('key-1', {
      ledgerKeyXdr: 'key-1',
      exists: true,
      liveUntilLedger: 500_000,
      lastModifiedLedger: 2,
    });
    await checkStorage(h.deps, c.id);
    expect((await prisma.alert.findUniqueOrThrow({ where: { id: open[0]!.id } })).status).toBe(
      'RESOLVED',
    );
  });

  it('notifies on resolve when the preference is set', async () => {
    const c = await createContract(21);
    const d = await webhookDestination('https://example.com/hook');
    await prisma.setting.create({
      data: {
        key: 'notificationPreferences',
        value: { notifyOnResolve: true, defaultDestinationIds: [d.id] },
      },
    });
    await prisma.storageEntry.create({
      data: { contractRefId: c.id, kind: 'INSTANCE', label: 'I', ledgerKeyXdr: 'k' },
    });
    await prisma.alertRule.create({
      data: {
        name: 'TTL',
        type: 'TTL_EXPIRY',
        cooldownSeconds: 0,
        config: { ledgersThreshold: 1000 },
      },
    });
    h.rpc.ttls.set('k', {
      ledgerKeyXdr: 'k',
      exists: true,
      liveUntilLedger: 1200,
      lastModifiedLedger: 1,
    });
    await checkStorage(h.deps, c.id);
    h.rpc.ttls.set('k', {
      ledgerKeyXdr: 'k',
      exists: true,
      liveUntilLedger: 900_000,
      lastModifiedLedger: 1,
    });
    await checkStorage(h.deps, c.id);
    const kinds = (
      await prisma.notificationDelivery.findMany({ orderBy: { createdAt: 'asc' } })
    ).map((x) => x.kind);
    expect(kinds).toEqual(['alert.triggered', 'alert.resolved']);
  });

  it('alerts when a polled contract has been silent too long and resolves when activity resumes', async () => {
    const c = await createContract(22, { createdAt: past(7200_000) });
    await prisma.contract.update({
      where: { id: c.id },
      data: { lastPolledAt: new Date(), lastEventAt: past(7200_000) },
    });
    await prisma.alertRule.create({
      data: {
        name: 'Quiet',
        type: 'INACTIVITY',
        cooldownSeconds: 0,
        config: { windowSeconds: 3600 },
        createdAt: past(7200_000),
      },
    });
    await checkInactivity(h.deps);
    const [alert] = await prisma.alert.findMany();
    expect(alert?.status).toBe('TRIGGERED');

    await prisma.contract.update({ where: { id: c.id }, data: { lastEventAt: new Date() } });
    await checkInactivity(h.deps);
    expect((await prisma.alert.findUniqueOrThrow({ where: { id: alert!.id } })).status).toBe(
      'RESOLVED',
    );
  });
});

describe('WASM upgrade rule', () => {
  it('alerts once when the WASM hash changes and follows the new code entry', async () => {
    const oldHash = 'aa'.repeat(32);
    const newHash = 'bb'.repeat(32);
    const c = await createContract(50);
    await prisma.contract.update({
      where: { id: c.id },
      data: {
        executableType: 'wasm',
        wasmHash: oldHash,
        storageEntries: {
          create: [
            { kind: 'INSTANCE', label: 'Contract instance', ledgerKeyXdr: 'instance-50' },
            { kind: 'CODE', label: 'Contract code (WASM)', ledgerKeyXdr: 'code-old' },
          ],
        },
      },
    });
    const d = await webhookDestination('https://example.com/hook');
    const rule = await prisma.alertRule.create({
      data: {
        name: 'Upgrades',
        type: 'WASM_CHANGED',
        severity: 'CRITICAL',
        config: {},
        destinations: { connect: [{ id: d.id }] },
      },
    });
    const info = {
      contractId: c.contractId,
      executableType: 'wasm' as const,
      wasmHash: oldHash,
      instanceLedgerKeyXdr: 'instance-50',
      codeLedgerKeyXdr: 'code-old',
      instanceLiveUntilLedger: 5000,
      codeLiveUntilLedger: 5000,
      latestLedger: 1000,
    };
    h.rpc.contractInfos.set(c.contractId, info);

    // Unchanged hash: nothing happens.
    await checkStorage(h.deps, c.id);
    expect(await prisma.alert.count()).toBe(0);

    h.rpc.contractInfos.set(c.contractId, {
      ...info,
      wasmHash: newHash,
      codeLedgerKeyXdr: 'code-new',
      codeLiveUntilLedger: 9000,
    });
    await checkStorage(h.deps, c.id);
    await checkStorage(h.deps, c.id);

    const alerts = await prisma.alert.findMany();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ ruleId: rule.id, severity: 'CRITICAL' });
    expect(alerts[0]!.title).toContain('WASM upgraded');
    expect(alerts[0]!.context).toMatchObject({ previousWasmHash: oldHash, newWasmHash: newHash });
    expect(h.queued).toHaveLength(1);

    const after = await prisma.contract.findUniqueOrThrow({
      where: { id: c.id },
      include: { storageEntries: { where: { kind: 'CODE' } } },
    });
    expect(after.wasmHash).toBe(newHash);
    expect(after.storageEntries).toHaveLength(1);
    expect(after.storageEntries[0]!.ledgerKeyXdr).toBe('code-new');
  });

  it('records a first-seen hash without alerting', async () => {
    const c = await createContract(51);
    await prisma.storageEntry.create({
      data: { contractRefId: c.id, kind: 'INSTANCE', label: 'i', ledgerKeyXdr: 'instance-51' },
    });
    await prisma.alertRule.create({ data: { name: 'U', type: 'WASM_CHANGED', config: {} } });
    h.rpc.contractInfos.set(c.contractId, {
      contractId: c.contractId,
      executableType: 'wasm',
      wasmHash: 'cc'.repeat(32),
      instanceLedgerKeyXdr: 'instance-51',
      codeLedgerKeyXdr: 'code-51',
      instanceLiveUntilLedger: 5000,
      codeLiveUntilLedger: 5000,
      latestLedger: 1000,
    });
    await checkStorage(h.deps, c.id);
    expect(await prisma.alert.count()).toBe(0);
    const after = await prisma.contract.findUniqueOrThrow({
      where: { id: c.id },
      include: { storageEntries: { where: { kind: 'CODE' } } },
    });
    expect(after.wasmHash).toBe('cc'.repeat(32));
    expect(after.storageEntries[0]!.ledgerKeyXdr).toBe('code-51');
  });
});

describe('webhook delivery', () => {
  let server: Server;
  let url: string;
  let respond: number;
  let received: { headers: IncomingMessage['headers']; body: string }[];

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received.push({ headers: req.headers, body });
        res.statusCode = respond;
        res.end(respond >= 400 ? 'nope' : 'ok');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  beforeEach(() => {
    respond = 200;
    received = [];
  });

  async function pendingAlertDelivery() {
    const c = await createContract(30);
    const d = await webhookDestination(url);
    const alert = await prisma.alert.create({
      data: {
        contractRefId: c.id,
        severity: 'CRITICAL',
        title: 'Big transfer',
        message: 'A transfer happened',
        context: { ledger: 700 },
        deliveries: { create: { destinationId: d.id, kind: 'alert.triggered' } },
      },
      include: { deliveries: true },
    });
    return { delivery: alert.deliveries[0]!, alert, contract: c };
  }

  it('POSTs a signed, versioned payload and marks the delivery succeeded', async () => {
    const { delivery, alert, contract } = await pendingAlertDelivery();
    await expect(
      deliverNotification(h.deps, delivery.id, { number: 1, isFinalAttempt: false }),
    ).resolves.toBe('sent');
    expect(received).toHaveLength(1);
    const { headers, body } = received[0]!;
    expect(
      verifyWebhookSignature({
        secret: 'whsec_test_secret_0123456789',
        timestamp: Number(headers['x-schm-timestamp']),
        body,
        signature: String(headers['x-schm-signature']),
      }),
    ).toBe(true);
    expect(headers['x-schm-delivery']).toBe(delivery.id);
    const payload = JSON.parse(body);
    expect(payload).toMatchObject({
      version: 1,
      type: 'alert.triggered',
      alert: {
        id: alert.id,
        severity: 'CRITICAL',
        contract: { contractId: contract.contractId, network: 'TESTNET' },
      },
    });
    expect(
      await prisma.notificationDelivery.findUniqueOrThrow({ where: { id: delivery.id } }),
    ).toMatchObject({
      status: 'SUCCEEDED',
      attempts: 1,
      responseStatus: 200,
    });
    // A redelivered job for an already-succeeded delivery is a no-op.
    expect(
      await deliverNotification(h.deps, delivery.id, { number: 2, isFinalAttempt: false }),
    ).toBe('skipped');
  });

  it('keeps 5xx failures pending for retry and fails on the final attempt', async () => {
    respond = 503;
    const { delivery } = await pendingAlertDelivery();
    await expect(
      deliverNotification(h.deps, delivery.id, { number: 1, isFinalAttempt: false }),
    ).rejects.toThrow(/503/);
    expect(
      await prisma.notificationDelivery.findUniqueOrThrow({ where: { id: delivery.id } }),
    ).toMatchObject({
      status: 'PENDING',
      attempts: 1,
      responseStatus: 503,
    });
    await expect(
      deliverNotification(h.deps, delivery.id, { number: 6, isFinalAttempt: true }),
    ).rejects.toThrow();
    expect(
      (await prisma.notificationDelivery.findUniqueOrThrow({ where: { id: delivery.id } })).status,
    ).toBe('FAILED');
  });

  it('fails immediately on 4xx responses', async () => {
    respond = 404;
    const { delivery } = await pendingAlertDelivery();
    await expect(
      deliverNotification(h.deps, delivery.id, { number: 1, isFinalAttempt: false }),
    ).rejects.toThrow(/404/);
    expect(
      (await prisma.notificationDelivery.findUniqueOrThrow({ where: { id: delivery.id } })).status,
    ).toBe('FAILED');
  });

  it('blocks private addresses when configured', async () => {
    h = createHarness({ WEBHOOK_BLOCK_PRIVATE_IPS: 'true' });
    const { delivery } = await pendingAlertDelivery();
    await expect(
      deliverNotification(h.deps, delivery.id, { number: 1, isFinalAttempt: false }),
    ).rejects.toThrow(/private address/);
    expect(received).toHaveLength(0);
    expect(
      (await prisma.notificationDelivery.findUniqueOrThrow({ where: { id: delivery.id } })).status,
    ).toBe('FAILED');
  });

  it('signs with an encrypted secret, and encrypts legacy plaintext secrets', async () => {
    const { delivery } = await pendingAlertDelivery();
    // pendingAlertDelivery stores a plaintext secret, as older versions did.
    expect(await encryptLegacySecrets(h.deps)).toEqual({ updated: 1 });
    expect(await encryptLegacySecrets(h.deps)).toEqual({ updated: 0 });
    const dest = await prisma.notificationDestination.findFirstOrThrow();
    expect((dest.config as { secret: string }).secret).toMatch(/^enc:v1:/);

    await deliverNotification(h.deps, delivery.id, { number: 1, isFinalAttempt: false });
    const { headers, body } = received[0]!;
    expect(
      verifyWebhookSignature({
        secret: 'whsec_test_secret_0123456789',
        timestamp: Number(headers['x-schm-timestamp']),
        body,
        signature: String(headers['x-schm-signature']),
      }),
    ).toBe(true);
  });

  it('fails permanently when the secret cannot be decrypted', async () => {
    const { delivery } = await pendingAlertDelivery();
    await encryptLegacySecrets(h.deps);
    h.deps.secrets = (await import('@stellar-health/db')).createSecretBox('ef'.repeat(32));
    await expect(
      deliverNotification(h.deps, delivery.id, { number: 1, isFinalAttempt: false }),
    ).rejects.toThrow(/Cannot read webhook secret/);
    expect(
      (await prisma.notificationDelivery.findUniqueOrThrow({ where: { id: delivery.id } })).status,
    ).toBe('FAILED');
  });

  it('sends test notifications by email', async () => {
    const d = await prisma.notificationDestination.create({
      data: { name: 'mail', type: 'EMAIL', config: { to: ['ops@example.com'] } },
    });
    const delivery = await prisma.notificationDelivery.create({
      data: { destinationId: d.id, kind: 'test' },
    });
    await deliverNotification(h.deps, delivery.id, { number: 1, isFinalAttempt: false });
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({ to: ['ops@example.com'] });
    expect(h.sent[0]!.subject).toContain('Test notification');
  });
});

describe('chat destinations', () => {
  let server: Server;
  let local: string;
  let respond: number;
  let received: { url: string; body: string }[];

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received.push({ url: String(req.headers['x-original-url']), body });
        res.statusCode = respond;
        res.end(respond >= 400 ? 'nope' : 'ok');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    local = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  beforeEach(() => {
    respond = 200;
    received = [];
    // Chat destinations only accept their provider's host, so route those calls to a local server.
    h.deps.fetchImpl = (input, init) =>
      fetch(local, {
        ...init,
        headers: { ...(init?.headers as Record<string, string>), 'x-original-url': String(input) },
      });
  });

  async function chatDelivery(type: 'SLACK', config: Record<string, unknown>) {
    const c = await createContract(40);
    const d = await prisma.notificationDestination.create({
      data: {
        name: type,
        type,
        config: sealDestinationConfig(h.deps.secrets, config) as Prisma.InputJsonValue,
      },
    });
    const alert = await prisma.alert.create({
      data: {
        contractRefId: c.id,
        severity: 'WARNING',
        title: 'Low <balance>',
        message: 'Balance dropped',
        context: {},
        deliveries: { create: { destinationId: d.id } },
      },
      include: { deliveries: true },
    });
    return { delivery: alert.deliveries[0]!, alert, destination: d };
  }

  it('posts Block Kit messages to Slack with the URL stored encrypted', async () => {
    const webhookUrl = 'https://hooks.slack.com/services/T000/B000/secret123';
    const { delivery, alert, destination } = await chatDelivery('SLACK', { webhookUrl });
    expect(JSON.stringify(destination.config)).not.toContain('hooks.slack.com');
    await expect(
      deliverNotification(h.deps, delivery.id, { number: 1, isFinalAttempt: false }),
    ).resolves.toBe('sent');
    expect(received).toHaveLength(1);
    expect(received[0]!.url).toBe(webhookUrl);
    const body = JSON.parse(received[0]!.body);
    expect(body.text).toBe('[WARNING] Low &lt;balance&gt;');
    expect(body.blocks.at(-1).elements[0].url).toContain(`/alerts/history?alert=${alert.id}`);
  });

  it('retries Slack 5xx and 429 responses but not 4xx', async () => {
    const { delivery } = await chatDelivery('SLACK', {
      webhookUrl: 'https://hooks.slack.com/services/T/B/x',
    });
    respond = 429;
    await expect(
      deliverNotification(h.deps, delivery.id, { number: 1, isFinalAttempt: false }),
    ).rejects.toThrow(/429/);
    expect(
      (await prisma.notificationDelivery.findUniqueOrThrow({ where: { id: delivery.id } })).status,
    ).toBe('PENDING');
    respond = 404;
    await expect(
      deliverNotification(h.deps, delivery.id, { number: 2, isFinalAttempt: false }),
    ).rejects.toThrow(/404/);
    expect(
      (await prisma.notificationDelivery.findUniqueOrThrow({ where: { id: delivery.id } })).status,
    ).toBe('FAILED');
  });

  it('rejects a stored Slack URL on another host', async () => {
    const { delivery } = await chatDelivery('SLACK', { webhookUrl: 'https://evil.example.com/x' });
    await expect(
      deliverNotification(h.deps, delivery.id, { number: 1, isFinalAttempt: false }),
    ).rejects.toThrow(/Invalid Slack configuration/);
    expect(received).toHaveLength(0);
  });
});

describe('maintenance', () => {
  it('prunes events past the retention period', async () => {
    const c = await createContract(40);
    const base = {
      contractRefId: c.id,
      network: 'TESTNET' as const,
      type: 'contract',
      txHash: 'a'.repeat(64),
      topics: [],
      topicsXdr: [],
      value: {},
      valueXdr: '',
    };
    await prisma.event.createMany({
      data: [
        { ...base, eventId: 'old', ledger: 1, ledgerClosedAt: past(40 * 86400_000) },
        { ...base, eventId: 'new', ledger: 2, ledgerClosedAt: new Date() },
      ],
    });
    expect(await pruneOldData(h.deps)).toEqual({ deleted: 1, auditDeleted: 0 });
    expect((await prisma.event.findMany()).map((e) => e.eventId)).toEqual(['new']);
  });

  async function seedAuditLog(oldRows: number) {
    const row = (createdAt: Date, i: number) => ({
      createdAt,
      actorType: 'admin',
      actorId: 'admin',
      actorName: 'Admin',
      method: 'POST',
      route: '/contracts',
      path: `/contracts/${i}`,
      statusCode: 201,
    });
    await prisma.auditLog.createMany({
      data: [
        ...Array.from({ length: oldRows }, (_, i) => row(past(400 * 86400_000), i)),
        row(past(10 * 86400_000), 999),
      ],
    });
  }

  it('prunes audit log rows past their retention in batches', async () => {
    await seedAuditLog(7);
    // Batches of 3: 3 + 3 + 1 rows.
    expect(await pruneOldData(h.deps, 3)).toMatchObject({ auditDeleted: 7 });
    expect((await prisma.auditLog.findMany()).map((r) => r.path)).toEqual(['/contracts/999']);
  });

  it('keeps the audit log forever when the retention is 0', async () => {
    h = createHarness({ AUDIT_LOG_RETENTION_DAYS: '0' });
    await seedAuditLog(2);
    expect(await pruneOldData(h.deps)).toMatchObject({ auditDeleted: 0 });
    expect(await prisma.auditLog.count()).toBe(3);
  });
});
