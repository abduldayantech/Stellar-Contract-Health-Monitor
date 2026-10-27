# syntax=docker/dockerfile:1.7
# One Dockerfile, three images:
#   docker build -f docker/Dockerfile --target api    -t schm-api .
#   docker build -f docker/Dockerfile --target worker -t schm-worker .
#   docker build -f docker/Dockerfile --target web    -t schm-web .

ARG NODE_VERSION=22.21.1

FROM node:${NODE_VERSION}-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NEXT_TELEMETRY_DISABLED=1
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/* \
  && corepack enable
WORKDIR /repo

# ---- Install all workspace dependencies (cached on lockfile changes) ----
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc* ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY packages/db/package.json packages/db/
COPY packages/db/prisma packages/db/prisma
COPY packages/shared-types/package.json packages/shared-types/
COPY packages/stellar-client/package.json packages/stellar-client/
COPY packages/alert-engine/package.json packages/alert-engine/
COPY packages/ui/package.json packages/ui/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

FROM deps AS source
COPY . .
RUN pnpm --filter @stellar-health/db generate

# ---- API / worker: bundle with tsup, then a production-only node_modules via pnpm deploy ----
FROM source AS build-api
RUN pnpm --filter @stellar-health/api build
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
  pnpm --filter @stellar-health/api deploy --prod --legacy /out \
  && cp -r apps/api/dist /out/dist && cp -r packages/db/prisma /out/prisma \
  && cd /out && ./node_modules/.bin/prisma generate --schema prisma/schema.prisma

FROM source AS build-worker
RUN pnpm --filter @stellar-health/worker build
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
  pnpm --filter @stellar-health/worker deploy --prod --legacy /out \
  && cp -r apps/worker/dist /out/dist && cp -r packages/db/prisma /out/prisma \
  && cd /out && ./node_modules/.bin/prisma generate --schema prisma/schema.prisma

# Runtime images: OS security updates, OpenSSL for Prisma, and no npm/corepack (unused at
# runtime and a source of CVEs in their bundled dependencies).
FROM node:${NODE_VERSION}-bookworm-slim AS runtime-base
RUN apt-get update && apt-get upgrade -y \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
     /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack

FROM runtime-base AS runtime-node
ENV NODE_ENV=production
WORKDIR /app
USER node

FROM runtime-node AS api
COPY --from=build-api --chown=node:node /out ./
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--enable-source-maps", "dist/index.js"]

FROM runtime-node AS worker
COPY --from=build-worker --chown=node:node /out ./
EXPOSE 4001
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s CMD node -e "fetch('http://127.0.0.1:'+(process.env.WORKER_METRICS_PORT||4001)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--enable-source-maps", "dist/index.js"]

# ---- Web: Next.js standalone output ----
FROM source AS build-web
RUN pnpm --filter @stellar-health/web build

FROM runtime-base AS web
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build-web --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build-web --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build-web --chown=node:node /repo/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/web/server.js"]
