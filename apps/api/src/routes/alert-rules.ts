import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Prisma } from '@stellar-health/db';
import {
  createAlertRuleSchema,
  parseRuleConfig,
  updateAlertRuleSchema,
} from '@stellar-health/shared-types';
import { HttpError, notFound } from '../lib/errors';
import { serializeRule } from '../lib/serialize';
import type { AppDeps } from '../app';

const include = {
  destinations: { select: { id: true, name: true, type: true } },
  contract: { select: { id: true, contractId: true, label: true, network: true } },
} as const;

export async function alertRuleRoutes(app: FastifyInstance, { prisma }: AppDeps) {
  async function assertDestinations(ids: string[]) {
    if (ids.length === 0) return;
    const found = await prisma.notificationDestination.count({ where: { id: { in: ids } } });
    if (found !== new Set(ids).size)
      throw new HttpError(400, 'INVALID_DESTINATION', 'One or more destinations do not exist');
  }

  app.get('/alert-rules', async (req) => {
    const q = z.object({ contractRefId: z.string().optional() }).parse(req.query);
    const rules = await prisma.alertRule.findMany({
      where: q.contractRefId
        ? { OR: [{ contractRefId: q.contractRefId }, { contractRefId: null }] }
        : {},
      include,
      orderBy: { createdAt: 'desc' },
    });
    return { items: rules.map(serializeRule) };
  });

  app.get('/alert-rules/:id', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const rule = await prisma.alertRule.findUnique({ where: { id }, include });
    if (!rule) throw notFound('Alert rule');
    return serializeRule(rule);
  });

  app.post('/alert-rules', async (req, reply) => {
    const body = createAlertRuleSchema.parse(req.body);
    await assertDestinations(body.destinationIds);
    if (body.contractRefId) {
      const exists = await prisma.contract.count({ where: { id: body.contractRefId } });
      if (!exists) throw new HttpError(400, 'INVALID_CONTRACT', 'Contract does not exist');
    }
    const rule = await prisma.alertRule.create({
      data: {
        name: body.name,
        type: body.type,
        contractRefId: body.contractRefId ?? null,
        enabled: body.enabled,
        severity: body.severity,
        cooldownSeconds: body.cooldownSeconds,
        config: body.config as Prisma.InputJsonValue,
        destinations: { connect: body.destinationIds.map((id) => ({ id })) },
      },
      include,
    });
    reply.status(201);
    return serializeRule(rule);
  });

  app.patch('/alert-rules/:id', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const body = updateAlertRuleSchema.parse(req.body);
    const existing = await prisma.alertRule.findUnique({ where: { id } });
    if (!existing) throw notFound('Alert rule');
    if (body.destinationIds) await assertDestinations(body.destinationIds);
    const config = body.config ? parseRuleConfig(existing.type, body.config).config : undefined;
    const rule = await prisma.alertRule.update({
      where: { id },
      data: {
        name: body.name,
        enabled: body.enabled,
        severity: body.severity,
        cooldownSeconds: body.cooldownSeconds,
        config: config as Prisma.InputJsonValue | undefined,
        destinations: body.destinationIds
          ? { set: body.destinationIds.map((d) => ({ id: d })) }
          : undefined,
      },
      include,
    });
    return serializeRule(rule);
  });

  app.delete('/alert-rules/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await prisma.alertRule.delete({ where: { id } });
    reply.status(204);
  });
}
