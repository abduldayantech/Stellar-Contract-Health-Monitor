import type { FastifyInstance, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import type { PrismaClient } from '@stellar-health/db';
import { HttpError } from './errors';
import { hasRole, requiredRole, type Role } from './policy';
import { hashToken, safeEqual } from './tokens';

export interface Principal {
  type: 'admin' | 'token';
  id: string;
  name: string;
  role: Role;
}

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
  }
  interface FastifyContextConfig {
    /** Set to true on routes that do not require an API token. */
    public?: boolean;
  }
}

export interface AuthOptions {
  prisma: PrismaClient;
  adminToken?: string;
}

function extractToken(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7).trim() || null;
  const alt = req.headers['x-api-key'];
  if (typeof alt === 'string' && alt.trim()) return alt.trim();
  return null;
}

/**
 * Bearer-token authentication. Tokens are stored hashed; the bootstrap admin token comes from env.
 * Routes opt out with `config: { public: true }`.
 */
export const authPlugin = fp<AuthOptions>(async (app: FastifyInstance, opts) => {
  const lastUsedWrites = new Map<string, number>();

  // preValidation (not onRequest) so the per-route rate limiter runs first and also
  // throttles requests with missing or wrong tokens.
  app.addHook('preValidation', async (req) => {
    if (req.routeOptions.config?.public) return;
    if (req.method === 'OPTIONS') return;
    const token = extractToken(req);
    if (!token) throw new HttpError(401, 'UNAUTHORIZED', 'Missing API token');

    if (opts.adminToken && safeEqual(token, opts.adminToken)) {
      req.principal = {
        type: 'admin',
        id: 'admin',
        name: 'Admin (bootstrap token)',
        role: 'ADMIN',
      };
      return;
    }
    const row = await opts.prisma.apiToken.findUnique({ where: { tokenHash: hashToken(token) } });
    if (!row || row.revokedAt)
      throw new HttpError(401, 'UNAUTHORIZED', 'Invalid or revoked API token');
    if (row.expiresAt && row.expiresAt.getTime() <= Date.now())
      throw new HttpError(401, 'TOKEN_EXPIRED', 'Token expired');
    req.principal = { type: 'token', id: row.id, name: row.name, role: row.role };
    const required = requiredRole(req.method, req.routeOptions.url ?? req.url);
    if (!hasRole(row.role, required)) {
      throw new HttpError(
        403,
        'FORBIDDEN',
        `This action needs the ${required.toLowerCase()} role; your token is ${row.role.toLowerCase()}`,
      );
    }

    // Throttle lastUsedAt writes to once a minute per token.
    const now = Date.now();
    if ((lastUsedWrites.get(row.id) ?? 0) < now - 60_000) {
      lastUsedWrites.set(row.id, now);
      opts.prisma.apiToken
        .update({ where: { id: row.id }, data: { lastUsedAt: new Date(now) } })
        .catch((err) => req.log.warn({ err }, 'failed to update token lastUsedAt'));
    }
  });

  // Audit trail: record every state-changing request made by an authenticated principal.
  app.addHook('onResponse', async (req, reply) => {
    if (!req.principal || req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS')
      return;
    // onResponse runs after the reply is sent, so awaiting adds no client latency.
    await opts.prisma.auditLog
      .create({
        data: {
          actorType: req.principal.type,
          actorId: req.principal.id,
          actorName: req.principal.name,
          method: req.method,
          route: req.routeOptions.url ?? 'unmatched',
          path: req.url.split('?')[0]!.slice(0, 500),
          statusCode: reply.statusCode,
          ip: req.ip ?? null,
        },
      })
      .catch((err) => req.log.error({ err }, 'failed to write audit log'));
  });
});
