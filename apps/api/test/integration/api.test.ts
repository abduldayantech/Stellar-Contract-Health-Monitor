import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { disconnectPrisma } from '@stellar-health/db';
import { resetDatabase } from '../../../../tests/support/test-db';
import { ADMIN_TOKEN, auth, contractId, createTestApp, type TestContext } from './helpers';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestApp();
});
afterAll(async () => {
  await ctx.app.close();
  await disconnectPrisma();
});
beforeEach(async () => {
  await resetDatabase(ctx.prisma);
  ctx.jobs.ingest = [];
  ctx.jobs.storage = [];
  ctx.jobs.deliveries = [];
  ctx.stellar.contracts.clear();
});

async function register(seed = 1, label = 'Token') {
  const id = contractId(seed);
  ctx.stellar.deploy(id);
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/contracts',
    headers: auth,
    payload: { contractId: id, network: 'TESTNET', label },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; contractId: string };
}

async function seedEvents(
  contractRefId: string,
  n: number,
  opts: { topic?: string; startLedger?: number } = {},
) {
  const base = opts.startLedger ?? 90_000;
  await ctx.prisma.event.createMany({
    data: Array.from({ length: n }, (_, i) => ({
      contractRefId,
      eventId: `${String(base + i).padStart(19, '0')}-0000000001`,
      network: 'TESTNET' as const,
      type: 'contract',
      ledger: base + i,
      ledgerClosedAt: new Date(Date.now() - (n - i) * 5000),
      txHash: (i % 16).toString(16).repeat(64),
      topics: [opts.topic ?? (i % 2 === 0 ? 'transfer' : 'mint'), 'GABC'],
      topicsXdr: [],
      value: { amount: String(i) },
      valueXdr: '',
      inSuccessfulContractCall: true,
    })),
  });
}

describe('status and auth', () => {
  it('serves health and readiness without a token', async () => {
    expect((await ctx.app.inject({ url: '/health' })).json()).toEqual({ status: 'ok' });
    const ready = await ctx.app.inject({ url: '/ready' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({ status: 'ready', database: true, redis: true });
  });

  it('exposes Prometheus metrics', async () => {
    const res = await ctx.app.inject({ url: '/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('schm_http_request_duration_seconds');
  });

  it('rejects requests without a valid token', async () => {
    expect((await ctx.app.inject({ url: '/contracts' })).statusCode).toBe(401);
    const bad = await ctx.app.inject({
      url: '/contracts',
      headers: { authorization: 'Bearer nope' },
    });
    expect(bad.statusCode).toBe(401);
    expect(bad.json().error.code).toBe('UNAUTHORIZED');
  });

  it('accepts the admin token and named API tokens, and rejects revoked ones', async () => {
    const me = await ctx.app.inject({ url: '/auth/me', headers: auth });
    expect(me.json().principal.type).toBe('admin');

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/settings/tokens',
      headers: auth,
      payload: { name: 'CI', role: 'ADMIN' },
    });
    expect(created.statusCode).toBe(201);
    const { token, id } = created.json();
    expect(token).toMatch(/^schm_/);

    const asToken = await ctx.app.inject({ url: '/auth/me', headers: { 'x-api-key': token } });
    expect(asToken.json().principal).toMatchObject({ type: 'token', name: 'CI', role: 'ADMIN' });

    // The plaintext token is never listed again.
    const list = await ctx.app.inject({ url: '/settings/tokens', headers: auth });
    expect(JSON.stringify(list.json())).not.toContain(token);

    // A token cannot revoke itself.
    const self = await ctx.app.inject({
      method: 'DELETE',
      url: `/settings/tokens/${id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(self.statusCode).toBe(400);

    expect(
      (await ctx.app.inject({ method: 'DELETE', url: `/settings/tokens/${id}`, headers: auth }))
        .statusCode,
    ).toBe(204);
    expect(
      (await ctx.app.inject({ url: '/auth/me', headers: { authorization: `Bearer ${token}` } }))
        .statusCode,
    ).toBe(401);
  });

  it('accepts empty JSON bodies on action endpoints and rejects malformed JSON', async () => {
    const c = await register();
    const json = { ...auth, 'content-type': 'application/json' };
    const empty = await ctx.app.inject({
      method: 'POST',
      url: `/contracts/${c.id}/refresh`,
      headers: json,
      payload: '',
    });
    expect(empty.statusCode).toBe(202);
    const bad = await ctx.app.inject({
      method: 'POST',
      url: '/contracts',
      headers: json,
      payload: '{nope',
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('INVALID_JSON');
  });

  it('reports full monitoring status', async () => {
    await register();
    const res = await ctx.app.inject({ url: '/status', headers: auth });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.database.ok).toBe(true);
    expect(body.totals.contracts).toEqual({ ACTIVE: 1 });
    expect(body.networks.find((n: { network: string }) => n.network === 'TESTNET')).toMatchObject({
      configured: true,
      latestLedger: 100_000,
    });
  });
});

describe('roles and audit log', () => {
  async function tokenFor(role: 'VIEWER' | 'EDITOR' | 'ADMIN') {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/settings/tokens',
      headers: auth,
      payload: { name: `${role} token`, role },
    });
    expect(res.json().role).toBe(role);
    return { authorization: `Bearer ${res.json().token}` };
  }

  it('defaults new tokens to the viewer role', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/settings/tokens',
      headers: auth,
      payload: { name: 'x' },
    });
    expect(res.json().role).toBe('VIEWER');
  });

  it('lets viewers read but not change anything', async () => {
    const c = await register(30);
    const viewer = await tokenFor('VIEWER');
    expect((await ctx.app.inject({ url: '/contracts', headers: viewer })).statusCode).toBe(200);
    expect((await ctx.app.inject({ url: '/settings/networks', headers: viewer })).statusCode).toBe(
      200,
    );
    const denied = await ctx.app.inject({
      method: 'POST',
      url: `/contracts/${c.id}/refresh`,
      headers: viewer,
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe('FORBIDDEN');
    expect((await ctx.app.inject({ url: '/settings/tokens', headers: viewer })).statusCode).toBe(
      403,
    );
    expect((await ctx.app.inject({ url: '/audit-log', headers: viewer })).statusCode).toBe(403);
  });

  it('lets editors manage monitoring but not settings or tokens', async () => {
    const c = await register(31);
    const editor = await tokenFor('EDITOR');
    const refresh = await ctx.app.inject({
      method: 'POST',
      url: `/contracts/${c.id}/refresh`,
      headers: editor,
    });
    expect(refresh.statusCode).toBe(202);
    const prefs = await ctx.app.inject({
      method: 'PUT',
      url: '/settings/notifications',
      headers: editor,
      payload: { notifyOnResolve: true },
    });
    expect(prefs.statusCode).toBe(403);
    const mint = await ctx.app.inject({
      method: 'POST',
      url: '/settings/tokens',
      headers: editor,
      payload: { name: 'escalate', role: 'ADMIN' },
    });
    expect(mint.statusCode).toBe(403);
  });

  it('records every change, including denied attempts, in the audit log', async () => {
    const c = await register(32);
    const viewer = await tokenFor('VIEWER');
    await ctx.app.inject({
      method: 'PATCH',
      url: `/contracts/${c.id}`,
      headers: auth,
      payload: { label: 'Renamed' },
    });
    await ctx.app.inject({ method: 'DELETE', url: `/contracts/${c.id}`, headers: viewer });
    await ctx.app.inject({ url: '/contracts', headers: auth }); // reads are not audited

    const log = (await ctx.app.inject({ url: '/audit-log?limit=10', headers: auth })).json();
    const rows = log.items.map(
      (r: { method: string; route: string; statusCode: number; actorName: string }) =>
        [r.method, r.route, r.statusCode, r.actorName].join(' '),
    );
    expect(rows[0]).toBe('DELETE /contracts/:id 403 VIEWER token');
    expect(rows[1]).toBe('PATCH /contracts/:id 200 Admin (bootstrap token)');
    expect(rows.some((r: string) => r.startsWith('GET'))).toBe(false);
    expect(log.items[0].path).toBe(`/contracts/${c.id}`);
  });
});

describe('contract registry', () => {
  it('validates contract IDs before touching the network', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/contracts/validate',
      headers: auth,
      payload: { contractId: 'GBAD', network: 'TESTNET' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_CONTRACT_ID');

    const missing = await ctx.app.inject({
      method: 'POST',
      url: '/contracts/validate',
      headers: auth,
      payload: { contractId: contractId(9), network: 'TESTNET' },
    });
    expect(missing.statusCode).toBe(422);
    expect(missing.json().error.code).toBe('CONTRACT_NOT_FOUND');
  });

  it('validates a deployed contract and reports whether it is registered', async () => {
    const id = contractId(2);
    ctx.stellar.deploy(id);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/contracts/validate',
      headers: auth,
      payload: { contractId: ` ${id.toLowerCase()} `, network: 'TESTNET' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      valid: true,
      contractId: id,
      executableType: 'wasm',
      alreadyRegistered: null,
    });
  });

  it('registers a contract, clamps the start ledger to RPC retention, and queues ingestion', async () => {
    const c = await register(3);
    expect(ctx.jobs.ingest).toEqual([c.id]);
    const row = await ctx.prisma.contract.findUniqueOrThrow({ where: { id: c.id } });
    // latest 100000 - lookback 17280 = 82720, which is inside retention (oldest 80000).
    expect(row.startLedger).toBe(82_720);

    const detail = (await ctx.app.inject({ url: `/contracts/${c.id}`, headers: auth })).json();
    expect(detail.storageEntries.map((s: { kind: string }) => s.kind)).toEqual([
      'INSTANCE',
      'CODE',
    ]);
    expect(detail.nearestExpiryLedgers).toBe(50_000);
    expect(detail.health).toBe('pending');

    const dup = await ctx.app.inject({
      method: 'POST',
      url: '/contracts',
      headers: auth,
      payload: { contractId: c.contractId, network: 'TESTNET' },
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.details.id).toBe(c.id);
  });

  it('never starts before the oldest retained ledger', async () => {
    const id = contractId(4);
    ctx.stellar.deploy(id);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/contracts',
      headers: auth,
      payload: { contractId: id, network: 'TESTNET', lookbackLedgers: 1_000_000 },
    });
    expect(res.json().startLedger).toBe(80_001);
  });

  it('pages through contracts with a cursor, returning each exactly once', async () => {
    const createdAt = new Date('2026-01-01T00:00:00Z');
    // Same createdAt for all rows, so ordering must fall back to the id tiebreaker.
    await ctx.prisma.contract.createMany({
      data: Array.from({ length: 23 }, (_, i) => ({
        contractId: contractId(100 + i),
        network: 'TESTNET' as const,
        startLedger: 1,
        createdAt,
      })),
    });
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await ctx.app.inject({
        url: `/contracts?limit=10${cursor ? `&cursor=${cursor}` : ''}`,
        headers: auth,
      });
      expect(res.statusCode).toBe(200);
      const page = res.json() as { items: { id: string }[]; nextCursor: string | null };
      seen.push(...page.items.map((c) => c.id));
      cursor = page.nextCursor;
      pages++;
    } while (cursor);
    expect(pages).toBe(3);
    expect(seen).toHaveLength(23);
    expect(new Set(seen).size).toBe(23);

    const defaults = (await ctx.app.inject({ url: '/contracts', headers: auth })).json();
    expect(defaults.items).toHaveLength(23);
    expect(defaults.nextCursor).toBeNull();
    expect((await ctx.app.inject({ url: '/contracts?limit=501', headers: auth })).statusCode).toBe(
      400,
    );
  });

  it('lists, searches, pauses and deletes contracts', async () => {
    const a = await register(5, 'Alpha token');
    await register(6, 'Beta pool');
    const all = (await ctx.app.inject({ url: '/contracts', headers: auth })).json();
    expect(all.items).toHaveLength(2);
    const search = (await ctx.app.inject({ url: '/contracts?search=alpha', headers: auth })).json();
    expect(search.items.map((c: { id: string }) => c.id)).toEqual([a.id]);

    const paused = await ctx.app.inject({
      method: 'PATCH',
      url: `/contracts/${a.id}`,
      headers: auth,
      payload: { status: 'PAUSED' },
    });
    expect(paused.json()).toMatchObject({ status: 'PAUSED', health: 'paused' });

    expect(
      (await ctx.app.inject({ method: 'DELETE', url: `/contracts/${a.id}`, headers: auth }))
        .statusCode,
    ).toBe(204);
    expect((await ctx.app.inject({ url: `/contracts/${a.id}`, headers: auth })).statusCode).toBe(
      404,
    );
  });

  it('adds and removes monitored storage entries', async () => {
    const c = await register(7);
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/contracts/${c.id}/storage-entries`,
      headers: auth,
      payload: {
        label: 'Admin',
        durability: 'PERSISTENT',
        keyType: 'enum_variant',
        key: 'DataKey::Admin',
      },
    });
    expect(res.statusCode).toBe(201);
    const entry = res.json();
    expect(entry).toMatchObject({ kind: 'PERSISTENT', exists: true, ledgersRemaining: 1000 });

    const instance = await ctx.prisma.storageEntry.findFirstOrThrow({
      where: { contractRefId: c.id, kind: 'INSTANCE' },
    });
    const blocked = await ctx.app.inject({
      method: 'DELETE',
      url: `/contracts/${c.id}/storage-entries/${instance.id}`,
      headers: auth,
    });
    expect(blocked.statusCode).toBe(400);

    const removed = await ctx.app.inject({
      method: 'DELETE',
      url: `/contracts/${c.id}/storage-entries/${entry.id}`,
      headers: auth,
    });
    expect(removed.statusCode).toBe(204);
  });

  it('queues a manual refresh', async () => {
    const c = await register(8);
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/contracts/${c.id}/refresh`,
      headers: auth,
    });
    expect(res.statusCode).toBe(202);
    expect(ctx.jobs.storage).toEqual([c.id]);
  });
});

describe('events', () => {
  it('paginates newest first without duplicates or gaps', async () => {
    const c = await register(10);
    await seedEvents(c.id, 25);
    const seen: number[] = [];
    let cursor: string | null = null;
    do {
      const url: string = `/events?contractRefId=${c.id}&limit=10${cursor ? `&cursor=${cursor}` : ''}`;
      const page = (await ctx.app.inject({ url, headers: auth })).json();
      seen.push(...page.items.map((e: { ledger: number }) => e.ledger));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toHaveLength(25);
    expect(new Set(seen).size).toBe(25);
    expect(seen).toEqual([...seen].sort((a, b) => b - a));
  });

  it('filters by topic, transaction, contract ID and time', async () => {
    const c = await register(11);
    const other = await register(12);
    await seedEvents(c.id, 10);
    await seedEvents(other.id, 4, { topic: 'burn', startLedger: 95_000 });

    const byTopic = (await ctx.app.inject({ url: '/events?topic=mint', headers: auth })).json();
    expect(byTopic.items).toHaveLength(5);

    const tx = '3'.repeat(64);
    const byTx = (
      await ctx.app.inject({ url: `/events?txHash=${tx.toUpperCase()}`, headers: auth })
    ).json();
    expect(byTx.items.every((e: { txHash: string }) => e.txHash === tx)).toBe(true);
    expect(byTx.items.length).toBeGreaterThan(0);

    const byContract = (
      await ctx.app.inject({ url: `/events?contractId=${other.contractId}`, headers: auth })
    ).json();
    expect(byContract.items).toHaveLength(4);

    const future = (
      await ctx.app.inject({
        url: `/events?from=${new Date(Date.now() + 60_000).toISOString()}`,
        headers: auth,
      })
    ).json();
    expect(future.items).toHaveLength(0);

    const badTx = await ctx.app.inject({ url: '/events?txHash=xyz', headers: auth });
    expect(badTx.statusCode).toBe(400);
    expect(badTx.json().error.code).toBe('VALIDATION_ERROR');

    const topics = (await ctx.app.inject({ url: '/events/topics', headers: auth })).json();
    expect(topics.items.map((t: { topic: string }) => t.topic).sort()).toEqual([
      'burn',
      'mint',
      'transfer',
    ]);
  });

  it('returns hourly activity for a contract', async () => {
    const c = await register(13);
    await seedEvents(c.id, 6);
    const res = (
      await ctx.app.inject({ url: `/contracts/${c.id}/activity?hours=24`, headers: auth })
    ).json();
    expect(res.bucket).toBe('hour');
    expect(res.points.reduce((s: number, p: { count: number }) => s + p.count, 0)).toBe(6);
  });
});

describe('alert rules, destinations and alert history', () => {
  async function webhook() {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/destinations',
      headers: auth,
      payload: { type: 'WEBHOOK', name: 'Ops hook', config: { url: 'https://example.com/hook' } },
    });
    expect(res.statusCode).toBe(201);
    return res.json() as { id: string; config: { secret: string } };
  }

  it('creates a webhook with a generated secret shown only once', async () => {
    const d = await webhook();
    expect(d.config.secret.length).toBeGreaterThanOrEqual(32);
    const list = (await ctx.app.inject({ url: '/destinations', headers: auth })).json();
    expect(JSON.stringify(list)).not.toContain(d.config.secret);

    const rotated = (
      await ctx.app.inject({
        method: 'POST',
        url: `/destinations/${d.id}/rotate-secret`,
        headers: auth,
      })
    ).json();
    expect(rotated.config.secret).not.toBe(d.config.secret);
  });

  it('stores webhook secrets and header values encrypted', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/destinations',
      headers: auth,
      payload: {
        type: 'WEBHOOK',
        name: 'Enc',
        config: {
          url: 'https://example.com/h',
          headers: { Authorization: 'Bearer downstream-token' },
        },
      },
    });
    const d = res.json();
    const row = await ctx.prisma.notificationDestination.findUniqueOrThrow({ where: { id: d.id } });
    const stored = JSON.stringify(row.config);
    expect(stored).not.toContain(d.config.secret);
    expect(stored).not.toContain('downstream-token');
    expect((row.config as { secret: string }).secret).toMatch(/^enc:v1:/);

    // Renaming keeps the secret usable; it is masked, never echoed.
    const patched = await ctx.app.inject({
      method: 'PATCH',
      url: `/destinations/${d.id}`,
      headers: auth,
      payload: { config: { url: 'https://example.com/h2' } },
    });
    expect(patched.json().config.url).toBe('https://example.com/h2');
    expect(patched.json().config.secret).not.toBe(d.config.secret);
    const after = await ctx.prisma.notificationDestination.findUniqueOrThrow({
      where: { id: d.id },
    });
    expect((after.config as { secret: string }).secret).toMatch(/^enc:v1:/);
  });

  it('rejects non-http webhook URLs and bad emails', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/destinations',
      headers: auth,
      payload: { type: 'WEBHOOK', name: 'x', config: { url: 'ftp://example.com' } },
    });
    expect(res.statusCode).toBe(400);
    const email = await ctx.app.inject({
      method: 'POST',
      url: '/destinations',
      headers: auth,
      payload: { type: 'EMAIL', name: 'x', config: { to: ['not-an-email'] } },
    });
    expect(email.statusCode).toBe(400);
  });

  it('queues a test delivery', async () => {
    const d = await webhook();
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/destinations/${d.id}/test`,
      headers: auth,
    });
    expect(res.statusCode).toBe(202);
    expect(ctx.jobs.deliveries).toHaveLength(1);
    const deliveries = (
      await ctx.app.inject({ url: `/destinations/${d.id}/deliveries`, headers: auth })
    ).json();
    expect(deliveries.items[0]).toMatchObject({ kind: 'test', status: 'PENDING' });
  });

  it('creates, updates and deletes rules with validated config', async () => {
    const c = await register(20);
    const d = await webhook();
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/alert-rules',
      headers: auth,
      payload: {
        name: 'Large transfers',
        type: 'EVENT_MATCH',
        contractRefId: c.id,
        destinationIds: [d.id],
        config: { topics: ['transfer', '**'], threshold: 3, windowSeconds: 60 },
      },
    });
    expect(created.statusCode).toBe(201);
    const rule = created.json();
    expect(rule).toMatchObject({ type: 'EVENT_MATCH', severity: 'WARNING', cooldownSeconds: 300 });
    expect(rule.destinations.map((x: { id: string }) => x.id)).toEqual([d.id]);

    const bad = await ctx.app.inject({
      method: 'PATCH',
      url: `/alert-rules/${rule.id}`,
      headers: auth,
      payload: { config: { threshold: 0 } },
    });
    expect(bad.statusCode).toBe(400);

    const updated = await ctx.app.inject({
      method: 'PATCH',
      url: `/alert-rules/${rule.id}`,
      headers: auth,
      payload: { enabled: false, config: { topics: ['mint'], threshold: 1 } },
    });
    expect(updated.json()).toMatchObject({
      enabled: false,
      config: { topics: ['mint'], threshold: 1 },
    });

    const missingDest = await ctx.app.inject({
      method: 'POST',
      url: '/alert-rules',
      headers: auth,
      payload: { name: 'x', type: 'INACTIVITY', destinationIds: ['nope'], config: {} },
    });
    expect(missingDest.json().error.code).toBe('INVALID_DESTINATION');

    expect(
      (await ctx.app.inject({ method: 'DELETE', url: `/alert-rules/${rule.id}`, headers: auth }))
        .statusCode,
    ).toBe(204);
  });

  it('acknowledges and resolves alerts, and retries failed deliveries', async () => {
    const c = await register(21);
    const d = await webhook();
    const rule = await ctx.prisma.alertRule.create({
      data: { name: 'Any event', type: 'EVENT_MATCH', contractRefId: c.id, config: {} },
    });
    const alert = await ctx.prisma.alert.create({
      data: {
        ruleId: rule.id,
        contractRefId: c.id,
        severity: 'CRITICAL',
        title: 'Something happened',
        message: 'details',
        context: {},
        deliveries: {
          create: {
            destinationId: d.id,
            kind: 'alert.triggered',
            status: 'FAILED',
            attempts: 6,
            lastError: 'boom',
          },
        },
      },
      include: { deliveries: true },
    });
    await ctx.prisma.alertRuleState.create({
      data: { ruleId: rule.id, contractRefId: c.id, openAlertId: alert.id },
    });

    const failed = (
      await ctx.app.inject({ url: '/alerts?deliveryStatus=FAILED', headers: auth })
    ).json();
    expect(failed.items.map((a: { id: string }) => a.id)).toEqual([alert.id]);

    const ack = await ctx.app.inject({
      method: 'POST',
      url: `/alerts/${alert.id}/acknowledge`,
      headers: auth,
    });
    expect(ack.json()).toMatchObject({
      status: 'ACKNOWLEDGED',
      acknowledgedBy: 'Admin (bootstrap token)',
    });
    expect(
      (
        await ctx.app.inject({
          method: 'POST',
          url: `/alerts/${alert.id}/acknowledge`,
          headers: auth,
        })
      ).statusCode,
    ).toBe(409);

    const retry = await ctx.app.inject({
      method: 'POST',
      url: `/deliveries/${alert.deliveries[0]!.id}/retry`,
      headers: auth,
    });
    expect(retry.statusCode).toBe(202);
    expect(retry.json()).toMatchObject({ status: 'PENDING', attempts: 0 });
    expect(ctx.jobs.deliveries).toEqual([alert.deliveries[0]!.id]);

    const resolved = await ctx.app.inject({
      method: 'POST',
      url: `/alerts/${alert.id}/resolve`,
      headers: auth,
    });
    expect(resolved.json().status).toBe('RESOLVED');
    const state = await ctx.prisma.alertRuleState.findFirstOrThrow({ where: { ruleId: rule.id } });
    expect(state.openAlertId).toBeNull();

    const summary = (await ctx.app.inject({ url: '/alerts/summary', headers: auth })).json();
    expect(summary.byStatus).toEqual({ RESOLVED: 1 });
  });
});

describe('settings', () => {
  it('stores notification preferences and validates default destinations', async () => {
    const res = await ctx.app.inject({
      method: 'PUT',
      url: '/settings/notifications',
      headers: auth,
      payload: { defaultCooldownSeconds: 60, notifyOnResolve: true, defaultDestinationIds: [] },
    });
    expect(res.statusCode).toBe(200);
    expect(
      (await ctx.app.inject({ url: '/settings/notifications', headers: auth })).json(),
    ).toEqual({
      defaultCooldownSeconds: 60,
      notifyOnResolve: true,
      defaultDestinationIds: [],
    });
    const bad = await ctx.app.inject({
      method: 'PUT',
      url: '/settings/notifications',
      headers: auth,
      payload: { defaultDestinationIds: ['missing'] },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('lists network providers with defaults', async () => {
    const res = (await ctx.app.inject({ url: '/settings/networks', headers: auth })).json();
    const testnet = res.items.find((n: { network: string }) => n.network === 'TESTNET');
    expect(testnet.defaultRpcUrl).toBe('https://soroban-testnet.stellar.org');
    expect(ADMIN_TOKEN.length).toBeGreaterThan(24);
  });
});
