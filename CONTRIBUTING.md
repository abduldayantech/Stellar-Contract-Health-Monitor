# Contributing

Thanks for helping improve Stellar Contract Health Monitor!

## Setup

```bash
pnpm install
cp .env.example .env          # set ADMIN_API_TOKEN
pnpm services:up              # Postgres and Redis in Docker
pnpm db:deploy
pnpm dev
```

Node.js 22 (see `.nvmrc`) and pnpm 10 are required.

## Before opening a pull request

```bash
pnpm format && pnpm lint && pnpm typecheck
pnpm test                     # unit tests
pnpm test:integration         # API + worker against Postgres
pnpm --filter @stellar-health/web build && pnpm test:e2e
```

CI runs all of these, plus Docker image builds, on every pull request.

The end-to-end suite includes `tests/e2e/a11y.spec.ts`, which runs [axe](https://github.com/dequelabs/axe-core)
(WCAG 2.1 A/AA) on every dashboard page in light and dark mode and fails on serious or critical
violations. When it fails, the message lists each rule and the elements involved. Common fixes:
give icons and meters an accessible name (or `aria-hidden`), pair `text-slate-500` with
`dark:text-slate-400` for contrast, and put `aria-expanded` on a button rather than a table row.

## Where things live

- Business rules that don't need I/O go in `packages/alert-engine` or `packages/stellar-client`,
  with unit tests next to them.
- API routes are in `apps/api/src/routes`; validate input with Zod schemas from
  `packages/shared-types` so the dashboard and API agree.
- Worker jobs are in `apps/worker/src`; each takes a `WorkerDeps` object so it can be tested with
  a fake RPC client (see `apps/worker/test/integration/helpers.ts`).
- Database changes: edit `packages/db/prisma/schema.prisma`, then
  `pnpm db:migrate --name <change>` and commit the generated migration.

## Guidelines

- Keep pull requests focused, and add tests for behaviour changes.
- Never assume unlimited event history from RPC: store what you need.
- Don't log secrets (API tokens, webhook secrets, SMTP passwords).
- Use [Conventional Commits](https://www.conventionalcommits.org/) style messages
  (`feat:`, `fix:`, `docs:`, …).

## Good first issues

- Additional notification channels (Slack, Discord, PagerDuty) as destination types.
- More rule types, e.g. failed-transaction rate or WASM upgrade detection.
- Dashboard charts for storage TTL over time.

## Reporting security issues

Please report vulnerabilities privately through GitHub security advisories rather than public
issues.
