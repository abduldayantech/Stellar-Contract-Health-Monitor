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

interface ErrorBody {
  code: string;
  message: string;
  details?: unknown;
}

/** Sends `{ error }` with the request ID so callers can quote it in support requests. */
export function sendError(
  req: FastifyRequest,
  reply: FastifyReply,
  statusCode: number,
  error: ErrorBody,
) {
  return reply.status(statusCode).send({ error: { ...error, requestId: req.id } });
}

export function errorHandler(err: FastifyError | Error, req: FastifyRequest, reply: FastifyReply) {
  if (err instanceof ZodError) {
    return sendError(req, reply, 400, {
      code: 'VALIDATION_ERROR',
      message: err.issues
        .map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message))
        .join('; '),
      details: err.issues,
    });
  }
  if (err instanceof HttpError) {
    return sendError(req, reply, err.statusCode, {
      code: err.code,
      message: err.message,
      details: err.details,
    });
  }
  if (err instanceof RpcError) {
    req.log.warn({ err }, 'RPC error');
    return sendError(req, reply, 502, {
      code: 'RPC_ERROR',
      message: `Stellar RPC error: ${err.message}`,
      details: { kind: err.kind },
    });
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2025')
      return sendError(req, reply, 404, { code: 'NOT_FOUND', message: 'Resource not found' });
    if (err.code === 'P2002')
      return sendError(req, reply, 409, { code: 'CONFLICT', message: 'Resource already exists' });
    if (err.code === 'P2003')
      return sendError(req, reply, 400, {
        code: 'INVALID_REFERENCE',
        message: 'Referenced resource does not exist',
      });
  }
  const fe = err as FastifyError;
  if (fe.statusCode && fe.statusCode < 500) {
    return sendError(req, reply, fe.statusCode, {
      code: fe.code ?? 'BAD_REQUEST',
      message: fe.message,
    });
  }
  req.log.error({ err }, 'Unhandled error');
  return sendError(req, reply, 500, { code: 'INTERNAL', message: 'Internal server error' });
}
