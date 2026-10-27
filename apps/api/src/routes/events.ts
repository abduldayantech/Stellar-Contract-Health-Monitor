import type { FastifyInstance } from 'fastify';
import type { Prisma } from '@stellar-health/db';
import { Readable } from 'node:stream';
import {
  exportEventsQuerySchema,
  listEventsQuerySchema,
  type ListEventsQuery,
} from '@stellar-health/shared-types';
import { eventCsvHeader, eventCsvRow, eventNdjsonRow, paginate } from '../lib/export';
import { notFound } from '../lib/errors';
import { toPage } from '../lib/pagination';
import { serializeEvent } from '../lib/serialize';
import type { AppDeps } from '../app';
import { doc } from '../openapi';
import { eventSchema, page, topicCountsSchema } from '../openapi/responses';

const tags = ['Events'];

const EVENT_ORDER: Prisma.EventOrderByWithRelationInput[] = [
  { ledger: 'desc' },
  { eventId: 'desc' },
  { id: 'desc' },
];

function eventWhere(q: Omit<ListEventsQuery, 'limit' | 'cursor'>): Prisma.EventWhereInput {
  return {
    contractRefId: q.contractRefId,
    network: q.network,
    type: q.type,
    txHash: q.txHash?.toLowerCase(),
    ...(q.contractId ? { contract: { contractId: q.contractId.trim().toUpperCase() } } : {}),
    ...(q.topic ? { topics: { has: q.topic } } : {}),
    ...(q.from || q.to ? { ledgerClosedAt: { gte: q.from, lte: q.to } } : {}),
  };
}

export async function eventRoutes(app: FastifyInstance, { prisma }: AppDeps) {
  app.get('/events', async (req) => {
    const q = listEventsQuerySchema.parse(req.query);
    const where = eventWhere(q);
    const rows = await prisma.event.findMany({
      where,
      orderBy: EVENT_ORDER,
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      include: { contract: { select: { contractId: true, label: true } } },
    });
    const page = toPage(rows, q.limit);
    return { items: page.items.map(serializeEvent), nextCursor: page.nextCursor };
  });

  // Streams every event matching the list filters (newest first, up to EXPORT_MAX_ROWS).
  app.get('/events/export', async (req, reply) => {
    const { format, ...filters } = exportEventsQuerySchema.parse(req.query);
    const where = eventWhere(filters);
    const rows = paginate((cursor, take) =>
      prisma.event.findMany({
        where,
        orderBy: EVENT_ORDER,
        take,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        include: { contract: { select: { contractId: true } } },
      }),
    );
    async function* lines() {
      if (format === 'csv') yield eventCsvHeader();
      for await (const row of rows) yield format === 'csv' ? eventCsvRow(row) : eventNdjsonRow(row);
    }
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    reply
      .header(
        'content-type',
        format === 'csv' ? 'text/csv; charset=utf-8' : 'application/x-ndjson; charset=utf-8',
      )
      .header('content-disposition', `attachment; filename="events-${stamp}.${format}"`)
      .header('cache-control', 'no-store');
    return reply.send(Readable.from(lines()));
  });

  app.get('/events/topics', async (req) => {
    // Distinct first topics, to populate filter suggestions in the UI.
    const { contractRefId } = z.object({ contractRefId: z.string().optional() }).parse(req.query);
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
