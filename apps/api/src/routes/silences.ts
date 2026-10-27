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

function serializeSilence(silence: {
  id: string;
  contractRefId: string | null;
  ruleId: string | null;
  startsAt: Date;
  endsAt: Date;
  recurrence: 'DAILY' | 'WEEKLY' | null;
  timeZone: string;
  reason: string;
  createdBy: string;
  createdAt: Date;
  contract?: { id: string; contractId: string; label: string | null; network: string } | null;
  rule?: { id: string; name: string; type: string } | null;
}) {
  return {
    id: silence.id,
    contractRefId: silence.contractRefId,
    ruleId: silence.ruleId,
    contract: silence.contract ?? null,
    rule: silence.rule ?? null,
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
      throw new HttpError(
        400,
        'INVALID_SCOPE',
        'A silence must target a contract, a rule, or both',
      );
    const [contractCount, ruleCount] = await Promise.all([
      contractRefId ? prisma.contract.count({ where: { id: contractRefId } }) : 1,
      ruleId ? prisma.alertRule.count({ where: { id: ruleId } }) : 1,
    ]);
    if (!contractCount) throw new HttpError(400, 'INVALID_CONTRACT', 'Contract does not exist');
    if (!ruleCount) throw new HttpError(400, 'INVALID_RULE', 'Alert rule does not exist');
  }

  app.get('/silences', async (req) => {
    const query = z
      .object({ contractRefId: z.string().optional(), ruleId: z.string().optional() })
      .parse(req.query);
    const filters: Prisma.SilenceWhereInput[] = [];
    if (query.contractRefId) {
      const applicableRules = await prisma.alertRule.findMany({
        where: { OR: [{ contractRefId: query.contractRefId }, { contractRefId: null }] },
        select: { id: true },
      });
      filters.push({
        OR: [
          { contractRefId: query.contractRefId },
          {
            contractRefId: null,
            OR: [{ ruleId: null }, { ruleId: { in: applicableRules.map((rule) => rule.id) } }],
          },
        ],
      });
    }
    if (query.ruleId) filters.push({ ruleId: query.ruleId });
    const rows = await prisma.silence.findMany({
      where: filters.length ? { AND: filters } : {},
      include,
      orderBy: [{ startsAt: 'desc' }, { createdAt: 'desc' }],
    });
    return { items: rows.map(serializeSilence) };
  });

  app.get('/silences/:id', async (req) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
    const row = await prisma.silence.findUnique({ where: { id }, include });
    if (!row) throw notFound('Silence');
    return serializeSilence(row);
  });

  app.post('/silences', async (req, reply) => {
    const body = createSilenceSchema.parse(req.body);
    const contractRefId = body.contractRefId ?? null;
    const ruleId = body.ruleId ?? null;
    await assertScope(contractRefId, ruleId);
    const row = await prisma.silence.create({
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
    return serializeSilence(row);
  });

  app.patch('/silences/:id', async (req) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
    const patch = updateSilenceSchema.parse(req.body);
    const existing = await prisma.silence.findUnique({ where: { id } });
    if (!existing) throw notFound('Silence');
    const body = createSilenceSchema.parse({ ...existing, ...patch });
    const contractRefId = body.contractRefId ?? null;
    const ruleId = body.ruleId ?? null;
    await assertScope(contractRefId, ruleId);
    const row = await prisma.silence.update({
      where: { id },
      data: {
        contractRefId,
        ruleId,
        startsAt: body.startsAt,
        endsAt: body.endsAt,
        recurrence: body.recurrence,
        timeZone: body.timeZone,
        reason: body.reason,
      },
      include,
    });
    return serializeSilence(row);
  });

  app.delete('/silences/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
    const deleted = await prisma.silence.deleteMany({ where: { id } });
    if (!deleted.count) throw notFound('Silence');
    reply.status(204);
  });
}
