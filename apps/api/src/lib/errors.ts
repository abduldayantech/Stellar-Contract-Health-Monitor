import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { Prisma } from '@stellar-health/db';
import { RpcError } from '@stellar-health/stellar-client';

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new HttpError(404, 'NOT_FOUND', `${what} not found`);

export function errorHandler(err: FastifyError | Error, req: FastifyRequest, reply: FastifyReply) {
  // Every error body names the request, so a report can be matched to the API logs.
  const send = (status: number, error: { code: string; message: string; details?: unknown }) =>
    reply.status(status).send({ error: { ...error, requestId: req.id } });

  if (err instanceof ZodError) {
    return send(400, {
      code: 'VALIDATION_ERROR',
      message: err.issues
        .map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message))
        .join('; '),
      details: err.issues,
    });
  }
  if (err instanceof HttpError) {
    return send(err.statusCode, { code: err.code, message: err.message, details: err.details });
  }
  if (err instanceof RpcError) {
    req.log.warn({ err }, 'RPC error');
    return send(502, {
      code: 'RPC_ERROR',
      message: `Stellar RPC error: ${err.message}`,
      details: { kind: err.kind },
    });
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2025')
      return send(404, { code: 'NOT_FOUND', message: 'Resource not found' });
    if (err.code === 'P2002')
      return send(409, { code: 'CONFLICT', message: 'Resource already exists' });
    if (err.code === 'P2003')
      return send(400, {
        code: 'INVALID_REFERENCE',
        message: 'Referenced resource does not exist',
      });
  }
  const fe = err as FastifyError;
  if (fe.statusCode && fe.statusCode < 500) {
    return send(fe.statusCode, { code: fe.code ?? 'BAD_REQUEST', message: fe.message });
  }
  req.log.error({ err }, 'Unhandled error');
  return send(500, { code: 'INTERNAL', message: 'Internal server error' });
}
