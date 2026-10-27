import type { FastifyInstance } from 'fastify';
import type { Prisma } from '@stellar-health/db';
import { resolveAllNetworkConfigs } from '@stellar-health/db';
import {
  NETWORK_DEFAULTS,
  createApiTokenSchema,
  idParamsSchema,
  listAuditLogQuerySchema,
  networkParamsSchema,
  notificationPreferencesSchema,
  testRpcSchema,
  upsertNetworkConfigSchema,
} from '@stellar-health/shared-types';
import { StellarRpcClient } from '@stellar-health/stellar-client';
import { HttpError } from '../lib/errors';
import { toPage } from '../lib/pagination';
import { generateApiToken, hashToken } from '../lib/tokens';
import type { AppDeps } from '../app';
import { doc } from '../openapi';
import {
  auditLogPageSchema,
  authMeSchema,
  createdTokenSchema,
  networkConfigListSchema,
  networkConfigSchema,
  rpcTestResultSchema,
  tokenListSchema,
} from '../openapi/responses';

const tags = ['Settings'];

export const PREFERENCES_KEY = 'notificationPreferences';

async function probeRpc(rpcUrl: string) {
  const client = new StellarRpcClient({ rpcUrl, retries: 0, timeoutMs: 8_000 });
  const started = Date.now();
  const [health, passphrase] = await Promise.all([
    client.getHealth(),
    client.getNetworkPassphrase(),
  ]);
  return { ...health, passphrase, latencyMs: Date.now() - started };
}

export async function settingsRoutes(app: FastifyInstance, { prisma }: AppDeps) {
  app.get(
    '/auth/me',
    {
      schema: doc({
        tags,
        summary: 'Who am I',
        description: "The token's name and role.",
        response: { 200: authMeSchema },
      }),
    },
    async (req) => ({ principal: req.principal }),
  );

  // ---- RPC providers ----
  app.get(
    '/settings/networks',
    {
      schema: doc({
        tags,
        summary: 'List RPC providers per network',
        description: 'Shows where each setting comes from (database, environment or default).',
        response: { 200: networkConfigListSchema },
      }),
    },
    async () => {
      const [configs, states] = await Promise.all([
        resolveAllNetworkConfigs(prisma),
        prisma.networkState.findMany(),
      ]);
      const stateMap = new Map(states.map((s) => [s.network, s]));
      return {
        items: configs.map((c) => ({
          ...c,
          defaultRpcUrl: NETWORK_DEFAULTS[c.network].rpcUrl || null,
          state: stateMap.get(c.network) ?? null,
        })),
      };
    },
  );

  app.put(
    '/settings/networks/:network',
    {
      schema: doc({
        tags,
        summary: 'Set the RPC provider for a network',
        description:
          'The RPC is probed first; it must be reachable and serve the expected network passphrase.',
        params: networkParamsSchema,
        body: upsertNetworkConfigSchema,
        response: { 200: networkConfigSchema },
      }),
    },
    async (req) => {
      const { network } = networkParamsSchema.parse(req.params);
      const body = upsertNetworkConfigSchema.parse(req.body);
      const passphrase = body.networkPassphrase ?? NETWORK_DEFAULTS[network].networkPassphrase;
      let probe;
      try {
        probe = await probeRpc(body.rpcUrl);
      } catch (err) {
        throw new HttpError(
          422,
          'RPC_UNREACHABLE',
          `Could not reach RPC at ${body.rpcUrl}: ${(err as Error).message}`,
        );
      }
      if (probe.passphrase !== passphrase) {
        throw new HttpError(
          422,
          'NETWORK_MISMATCH',
          `This RPC serves "${probe.passphrase}", but ${network} expects "${passphrase}".`,
        );
      }
      const row = await prisma.networkConfig.upsert({
        where: { network },
        create: {
          network,
          rpcUrl: body.rpcUrl,
          networkPassphrase: passphrase,
          enabled: body.enabled ?? true,
        },
        update: {
          rpcUrl: body.rpcUrl,
          networkPassphrase: passphrase,
          enabled: body.enabled ?? true,
        },
      });
      return { ...row, probe };
    },
  );

  app.delete(
    '/settings/networks/:network',
    {
      schema: doc({
        tags,
        summary: "Remove a network's RPC override",
        description: 'The network falls back to its environment variable or built-in default.',
        params: networkParamsSchema,
        response: { 204: null },
      }),
    },
    async (req, reply) => {
      const { network } = networkParamsSchema.parse(req.params);
      await prisma.networkConfig.deleteMany({ where: { network } });
      reply.status(204);
    },
  );

  app.post(
    '/settings/networks/test',
    {
      schema: doc({
        tags,
        summary: 'Test an RPC URL',
        description:
          'Probes the RPC without saving it. Failures return `ok: false` with status 200.',
        body: testRpcSchema,
        response: { 200: rpcTestResultSchema },
      }),
    },
    async (req) => {
      const body = testRpcSchema.parse(req.body);
      try {
        return { ok: true, ...(await probeRpc(body.rpcUrl)) };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    },
  );

  // ---- API tokens ----
  app.get('/settings/tokens', async () => {
    const rows = await prisma.apiToken.findMany({ orderBy: { createdAt: 'desc' } });
    return {
      items: rows.map((t) => ({
        id: t.id,
        name: t.name,
        role: t.role,
        prefix: t.prefix,
        createdAt: t.createdAt,
        lastUsedAt: t.lastUsedAt,
        revokedAt: t.revokedAt,
        expiresAt: t.expiresAt,
      })),
    };
  });

  app.post('/settings/tokens', async (req, reply) => {
    const body = createApiTokenSchema.parse(req.body);
    const token = generateApiToken();
    const row = await prisma.apiToken.create({
      data: {
        name: body.name,
        role: body.role,
        tokenHash: hashToken(token),
        prefix: token.slice(0, 12),
        expiresAt: body.expiresInDays
          ? new Date(Date.now() + body.expiresInDays * 86400_000)
          : null,
      },
    });
    reply.status(201);
    // Plaintext token is returned exactly once.
    return {
      id: row.id,
      name: row.name,
      role: row.role,
      prefix: row.prefix,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      token,
    };
  });

  app.delete(
    '/settings/tokens/:id',
    {
      schema: doc({
        tags,
        summary: 'Revoke an API token',
        description: 'You cannot revoke the token you are using.',
        params: idParamsSchema,
        response: { 204: null },
      }),
    },
    async (req, reply) => {
      const { id } = idParamsSchema.parse(req.params);
      if (req.principal?.type === 'token' && req.principal.id === id) {
        throw new HttpError(
          400,
          'CANNOT_REVOKE_SELF',
          'You cannot revoke the token you are signed in with',
        );
      }
      await prisma.apiToken.update({ where: { id }, data: { revokedAt: new Date() } });
      reply.status(204);
    },
  );

  // ---- Audit log ----
  app.get(
    '/audit-log',
    {
      schema: doc({
        tags,
        summary: 'List changes made through the API',
        description: 'Every state-changing request, newest first, paginated with `cursor`.',
        querystring: listAuditLogQuerySchema,
        response: { 200: auditLogPageSchema },
      }),
    },
    async (req) => {
      const q = listAuditLogQuerySchema.parse(req.query);
      const rows = await prisma.auditLog.findMany({
        where: { actorId: q.actorId, method: q.method },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: q.limit + 1,
        ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      });
      return toPage(rows, q.limit);
    },
  );

  // ---- Notification preferences ----
  app.get(
    '/settings/notifications',
    {
      schema: doc({
        tags,
        summary: 'Get notification preferences',
        response: { 200: notificationPreferencesSchema },
      }),
    },
    async () => {
      const row = await prisma.setting.findUnique({ where: { key: PREFERENCES_KEY } });
      return notificationPreferencesSchema.parse(row?.value ?? {});
    },
  );

  app.put(
    '/settings/notifications',
    {
      schema: doc({
        tags,
        summary: 'Replace notification preferences',
        body: notificationPreferencesSchema,
        response: { 200: notificationPreferencesSchema },
      }),
    },
    async (req) => {
      const prefs = notificationPreferencesSchema.parse(req.body);
      if (prefs.defaultDestinationIds.length) {
        const n = await prisma.notificationDestination.count({
          where: { id: { in: prefs.defaultDestinationIds } },
        });
        if (n !== new Set(prefs.defaultDestinationIds).size) {
          throw new HttpError(400, 'INVALID_DESTINATION', 'One or more destinations do not exist');
        }
      }
      await prisma.setting.upsert({
        where: { key: PREFERENCES_KEY },
        create: { key: PREFERENCES_KEY, value: prefs as Prisma.InputJsonValue },
        update: { value: prefs as Prisma.InputJsonValue },
      });
      return prefs;
    },
  );
}
