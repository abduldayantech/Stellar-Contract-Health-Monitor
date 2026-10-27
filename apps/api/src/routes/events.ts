import type { FastifyInstance } from 'fastify';
import type { Prisma } from '@stellar-health/db';
import {
  idParamsSchema,
  listEventTopicsQuerySchema,
  listEventsQuerySchema,
} from '@stellar-health/shared-types';
import { notFound } from '../lib/errors';
import { toPage } from '../lib/pagination';
import { serializeEvent } from '../lib/serialize';
import type { AppDeps } from '../app';
import { doc } from '../openapi';
import { eventSchema, page, topicCountsSchema } from '../openapi/responses';

const tags = ['Events'];

export async function eventRoutes(app: FastifyInstance, { prisma }: AppDeps) {
  app.get(
    '/events',
    {
      schema: doc({
        tags,
        summary: 'Search ingested events',
        description: 'Newest ledger first, paginated with `cursor`. `topic` matches any topic.',
        querystring: listEventsQuerySchema,
        response: { 200: page(eventSchema) },
      }),
    },
    async (req) => {
      const q = listEventsQuerySchema.parse(req.query);
      const where: Prisma.EventWhereInput = {
        contractRefId: q.contractRefId,
        network: q.network,
        type: q.type,
        txHash: q.txHash?.toLowerCase(),
        ...(q.contractId ? { contract: { contractId: q.contractId.trim().toUpperCase() } } : {}),
        ...(q.topic ? { topics: { has: q.topic } } : {}),
        ...(q.from || q.to ? { ledgerClosedAt: { gte: q.from, lte: q.to } } : {}),
      };
      const rows = await prisma.event.findMany({
        where,
        orderBy: [{ ledger: 'desc' }, { eventId: 'desc' }, { id: 'desc' }],
        take: q.limit + 1,
        ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
        include: { contract: { select: { contractId: true, label: true } } },
      });
      const page = toPage(rows, q.limit);
      return { items: page.items.map(serializeEvent), nextCursor: page.nextCursor };
    },
  );

  app.get(
    '/events/topics',
    {
      schema: doc({
        tags,
        summary: 'Most common first topics',
        description: 'Up to 50 distinct first topics with counts, for filter suggestions.',
        querystring: listEventTopicsQuerySchema,
        response: { 200: topicCountsSchema },
      }),
    },
    async (req) => {
      const { contractRefId } = listEventTopicsQuerySchema.parse(req.query);
      const rows = contractRefId
        ? await prisma.$queryRaw<{ topic: string; count: bigint }[]>`
          SELECT "topics"[1] AS topic, COUNT(*)::bigint AS count FROM "Event"
          WHERE "contractRefId" = ${contractRefId} AND array_length("topics", 1) > 0
          GROUP BY 1 ORDER BY 2 DESC LIMIT 50`
        : await prisma.$queryRaw<{ topic: string; count: bigint }[]>`
          SELECT "topics"[1] AS topic, COUNT(*)::bigint AS count FROM "Event"
          WHERE array_length("topics", 1) > 0
          GROUP BY 1 ORDER BY 2 DESC LIMIT 50`;
      return { items: rows.map((r) => ({ topic: r.topic, count: Number(r.count) })) };
    },
  );

  app.get(
    '/events/:id',
    {
      schema: doc({
        tags,
        summary: 'Get an event',
        params: idParamsSchema,
        response: { 200: eventSchema },
      }),
    },
    async (req) => {
      const { id } = idParamsSchema.parse(req.params);
      const e = await prisma.event.findUnique({
        where: { id },
        include: { contract: { select: { contractId: true, label: true } } },
      });
      if (!e) throw notFound('Event');
      return serializeEvent(e);
    },
  );
}
