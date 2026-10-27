import type { FastifyInstance } from 'fastify';
import type { Prisma } from '@stellar-health/db';
import { alertActionSchema, listAlertsQuerySchema } from '@stellar-health/shared-types';
import { HttpError, notFound } from '../lib/errors';
import { toPage } from '../lib/pagination';
import { serializeAlert, serializeDelivery } from '../lib/serialize';
import { doc } from '../openapi';
import { alertSchema, alertSummarySchema, deliverySchema, page } from '../openapi/responses';
import type { AppDeps } from '../app';

const include = {
  rule: { select: { id: true, name: true, type: true } },
  contract: { select: { id: true, contractId: true, label: true, network: true } },
  deliveries: {
    orderBy: { createdAt: 'asc' },
    include: { destination: { select: { id: true, name: true, type: true } } },
  },
} satisfies Prisma.AlertInclude;

export async function alertRoutes(app: FastifyInstance, { prisma, jobs }: AppDeps) {
  const tags = ['Alerts'];

  app.get(
    '/alerts',
    {
      schema: doc({
        tags,
        summary: 'List alerts',
        description: 'Newest first, paginated with `cursor`.',
        querystring: listAlertsQuerySchema,
        response: { 200: page(alertSchema) },
      }),
    },
    async (req) => {
      const q = listAlertsQuerySchema.parse(req.query);
      const rows = await prisma.alert.findMany({
        where: {
          status: q.status,
          contractRefId: q.contractRefId,
          ruleId: q.ruleId,
          ...(q.deliveryStatus ? { deliveries: { some: { status: q.deliveryStatus } } } : {}),
        },
        orderBy: [{ triggeredAt: 'desc' }, { id: 'desc' }],
        take: q.limit + 1,
        ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
        include,
      });
      const page = toPage(rows, q.limit);
      return { items: page.items.map(serializeAlert), nextCursor: page.nextCursor };
    },
  );

  app.get(
    '/alerts/summary',
    {
      schema: doc({
        tags,
        summary: 'Count alerts by status',
        response: { 200: alertSummarySchema },
      }),
    },
    async () => {
      const [byStatus, failedDeliveries] = await Promise.all([
        prisma.alert.groupBy({ by: ['status'], _count: { _all: true } }),
        prisma.notificationDelivery.count({ where: { status: 'FAILED' } }),
      ]);
      return {
        byStatus: Object.fromEntries(byStatus.map((s) => [s.status, s._count._all])),
        failedDeliveries,
      };
    },
  );

  app.post('/alerts/:id/acknowledge', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { note } = alertActionSchema.parse(req.body);
    const a = await prisma.alert.findUnique({ where: { id } });
    if (!a) throw notFound('Alert');
    if (a.status !== 'TRIGGERED')
      throw new HttpError(409, 'INVALID_STATE', `Alert is already ${a.status.toLowerCase()}`);
    const updated = await prisma.alert.update({
      where: { id },
      data: {
        status: 'ACKNOWLEDGED',
        acknowledgedAt: new Date(),
        acknowledgedBy: req.principal?.name ?? null,
        acknowledgeNote: note,
      },
      include,
    });
    return serializeAlert(updated);
  });

  app.post('/alerts/:id/resolve', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { note } = alertActionSchema.parse(req.body);
    const a = await prisma.alert.findUnique({ where: { id } });
    if (!a) throw notFound('Alert');
    if (a.status === 'RESOLVED')
      throw new HttpError(409, 'INVALID_STATE', 'Alert is already resolved');
    const updated = await prisma.$transaction(async (tx) => {
      // Clear any open-alert pointer so level rules can fire again if the condition recurs.
      await tx.alertRuleState.updateMany({
        where: { openAlertId: id },
        data: { openAlertId: null },
      });
      return tx.alert.update({
        where: { id },
        data: {
          status: 'RESOLVED',
          resolvedAt: new Date(),
          resolvedBy: req.principal?.name ?? null,
          resolveNote: note,
        },
        include,
      });
      return serializeAlert(updated);
    },
  );

  app.post(
    '/alerts/:id/resolve',
    {
      schema: doc({
        tags,
        summary: 'Resolve an alert',
        description: 'No request body.',
        params: idParamsSchema,
        response: { 200: alertSchema },
      }),
    },
    async (req) => {
      const { id } = idParamsSchema.parse(req.params);
      const a = await prisma.alert.findUnique({ where: { id } });
      if (!a) throw notFound('Alert');
      if (a.status === 'RESOLVED')
        throw new HttpError(409, 'INVALID_STATE', 'Alert is already resolved');
      const updated = await prisma.$transaction(async (tx) => {
        // Clear any open-alert pointer so level rules can fire again if the condition recurs.
        await tx.alertRuleState.updateMany({
          where: { openAlertId: id },
          data: { openAlertId: null },
        });
        return tx.alert.update({
          where: { id },
          data: { status: 'RESOLVED', resolvedAt: new Date() },
          include,
        });
      });
      return serializeAlert(updated);
    },
  );

  app.post(
    '/deliveries/:id/retry',
    {
      schema: doc({
        tags,
        summary: 'Retry a failed notification delivery',
        description: 'No request body.',
        params: idParamsSchema,
        response: { 202: deliverySchema },
      }),
    },
    async (req, reply) => {
      const { id } = idParamsSchema.parse(req.params);
      const d = await prisma.notificationDelivery.findUnique({ where: { id } });
      if (!d) throw notFound('Delivery');
      if (d.status !== 'FAILED')
        throw new HttpError(409, 'INVALID_STATE', 'Only failed deliveries can be retried');
      const updated = await prisma.notificationDelivery.update({
        where: { id },
        data: { status: 'PENDING', attempts: 0, lastError: null },
        include: { destination: { select: { id: true, name: true, type: true } } },
      });
      await jobs.enqueueDelivery(id);
      reply.status(202);
      return serializeDelivery(updated);
    },
  );
}
