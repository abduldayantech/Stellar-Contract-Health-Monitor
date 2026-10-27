import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Prisma } from '@stellar-health/db';
import { createSilenceSchema, updateSilenceSchema } from '@stellar-health/shared-types';
import { HttpError, notFound } from '../lib/errors';
import type { AppDeps } from '../app';

const include = {
  contract: { select: { id: true, contractId: true, label: true, network: true } },
  rule: { select: { id: true, name: true, type: true } },
} as const;

function serializeSilence(silence: Prisma.SilenceGetPayload<{ include: typeof include }>) {
  return {
    id: silence.id,
    contractRefId: silence.contractRefId,
    contract: silence.contract,
    ruleId: silence.ruleId,
    rule: silence.rule,
    startsAt: silence.startsAt,
    endsAt: silence.endsAt,
    recurrence: silence.recurrence,
    timeZone: silence.timeZone,
    reason: silence.reason,
    createdBy: silence.createdBy,
    createdAt: silence.createdAt,
  };
}

export async function silenceRoutes(app: FastifyInstance, { prisma }: AppDeps) {
  async function assertScope(contractRefId: string | null, ruleId: string | null) {
    if (!contractRefId && !ruleId)
      throw new HttpError(400, 'INVALID_SCOPE', 'A contract or rule scope is required');
    if (contractRefId && !(await prisma.contract.count({ where: { id: contractRefId } })))
      throw new HttpError(400, 'INVALID_CONTRACT', 'Contract does not exist');
    if (ruleId) {
      const rule = await prisma.alertRule.findUnique({ where: { id: ruleId } });
      if (!rule) throw new HttpError(400, 'INVALID_RULE', 'Alert rule does not exist');
      if (contractRefId && rule.contractRefId && rule.contractRefId !== contractRefId)
        throw new HttpError(400, 'INVALID_SCOPE', 'Rule belongs to a different contract');
    }
  }

  app.get('/silences', async (req) => {
    const query = z
      .object({ contractRefId: z.string().optional(), ruleId: z.string().optional() })
      .parse(req.query);
    const filters: Prisma.SilenceWhereInput[] = [];
    if (query.contractRefId) {
      const rules = await prisma.alertRule.findMany({
        where: { OR: [{ contractRefId: query.contractRefId }, { contractRefId: null }] },
        select: { id: true },
      });
      filters.push({
        OR: [
          { contractRefId: query.contractRefId },
          { ruleId: { in: rules.map((rule) => rule.id) } },
        ],
      });
    }
    if (query.ruleId) filters.push({ ruleId: query.ruleId });
    const silences = await prisma.silence.findMany({
      where: filters.length ? { AND: filters } : {},
      include,
      orderBy: { createdAt: 'desc' },
    });
    return { items: silences.map(serializeSilence) };
  });

  app.get('/silences/:id', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const silence = await prisma.silence.findUnique({ where: { id }, include });
    if (!silence) throw notFound('Silence');
    return serializeSilence(silence);
  });

  app.post('/silences', async (req, reply) => {
    const body = createSilenceSchema.parse(req.body);
    const contractRefId = body.contractRefId ?? null;
    const ruleId = body.ruleId ?? null;
    await assertScope(contractRefId, ruleId);
    const silence = await prisma.silence.create({
      data: {
        contractRefId,
        ruleId,
        startsAt: body.startsAt,
        endsAt: body.endsAt,
        recurrence: body.recurrence,
        timeZone: body.timeZone,
        reason: body.reason,
        createdBy: req.principal!.name,
      },
      include,
    });
    reply.status(201);
    return serializeSilence(silence);
  });

  app.patch('/silences/:id', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const body = updateSilenceSchema.parse(req.body);
    const existing = await prisma.silence.findUnique({ where: { id } });
    if (!existing) throw notFound('Silence');
    const contractRefId =
      body.contractRefId === undefined ? existing.contractRefId : body.contractRefId;
    const ruleId = body.ruleId === undefined ? existing.ruleId : body.ruleId;
    const startsAt = body.startsAt ?? existing.startsAt;
    const endsAt = body.endsAt ?? existing.endsAt;
    if (endsAt <= startsAt)
      throw new HttpError(400, 'INVALID_TIME_RANGE', 'endsAt must be after startsAt');
    await assertScope(contractRefId, ruleId);
    const silence = await prisma.silence.update({
      where: { id },
      data: {
        contractRefId,
        ruleId,
        startsAt,
        endsAt,
        recurrence: body.recurrence,
        timeZone: body.timeZone,
        reason: body.reason,
      },
      include,
    });
    return serializeSilence(silence);
  });

  app.delete('/silences/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    if (!(await prisma.silence.findUnique({ where: { id }, select: { id: true } })))
      throw notFound('Silence');
    await prisma.silence.delete({ where: { id } });
    reply.status(204);
  });
}
