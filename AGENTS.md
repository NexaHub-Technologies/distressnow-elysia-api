# DistressNow API (Elysia rebuild) — Repository Guidelines

## Project Overview

`distressnow-elysia-api` is a **Bun + Elysia + Postgres** REST API backend for DistressNow —
a port of the Laravel 11 `DistressNowApi` backend. It provides authentication, identity
(KYC), role authorization, store management, service provider applications, product
listings, booking/review flows, chat/support/notification engagement, payments, media,
and admin review queues.

External services:
- **Resend** — transactional email (verification, password reset, KYC decisions)
- **Termii** — SMS + OTP codes
- **Cloudinary** — media storage (KYC documents, listing images, uploads)
- **Paystack** — payment initialization/verification/webhooks
- **Expo Push** — push notifications

## Development Norms & Coding Standards

1. **API versioning**: all routes under `/api/v1` (see `src/index.ts` mount order).
2. **Module layout**: one directory per domain under `src/modules/<domain>/index.ts`.
   Each module owns routes + TypeBox validation + data access. Keep modules cohesive
   and prefer re-exporting a single plugin per module.
3. **Response envelope**: every handler returns `{ success, message, data, errors }`
   via `ok()` / `created()` / `fail()` from `src/utils/response.ts`. Paginated lists
   add `meta: { current_page, per_page, total, last_page }` (see `src/utils/pagination.ts`).
4. **Auth & guards** (`src/modules/auth/index.ts`): `applyAuthGuard` attaches
   the JWT guard directly to an instance (resolving `currentUser` from the
   shared UserStore and rejecting unauthenticated/suspended callers),
   `applyOptionalAuth` resolves `currentUser` without rejecting (for routes
   that must stay reachable anonymously, e.g. referrals register, payments
   webhook). JWT payload is `{ sub }` only — roles come from
   `currentUser.roles` (store-loaded). Modules mint tokens via
   `mintJwtToken(secret, userId)` and verify with `@elysiajs/jwt` (HS256,
   7-day expiry). All route modules (auth, kyc, applications, admin, media,
   payments, chat, notifications, support, adverts, referrals, safety) use the
   real guard — no `x-user-id`/`x-user-role` header stubs remain.
5. **Schema & migrations**: single source of truth `src/db/schema.ts` (drizzle pg
   schema, 38 tables). Generate SQL with `bun run db:generate`, apply with
   `bun run db:push` (dev) or `bun run db:migrate`. Never hand-edit `drizzle/*.sql`.
6. **DB-backed stores**: `src/db/stores.ts` provides Postgres-backed
   UserStore/OtpStore/KycStore/application stores with an in-memory fallback when
   `DATABASE_URL` is unreachable (auto-probed at boot). Prefer extending these over
   adding new in-memory state for production paths.
7. **Environment & configuration**: copy `.env.example` → `.env`. Keep secrets out of
   tracking. New env vars must be added to `src/env.ts` (zod) + `.env.example`.
8. **External services**: all service clients live in `src/services/` and degrade to a
   logged **mock mode** when their API key is missing — tests stay deterministic.
9. **Seeding**: master data is seeded via `bun run db:seed` (`src/db/seed.ts`):
   15 categories, 37 states, 905 sublocations, 2,613 markets (from
   `src/db/data/markets.json`), 6 roles, 5 staff users (password `18781875`).

## Testing & Quality Assurance Mandatory Rules

- **Strict rule**: unit/feature tests exist for every new feature and pass cleanly
  before committing.
- **Run tests**: `bun test` (131 tests / 6 files: auth, kyc, marketplace, engagement,
  payments, admin). Single file: `bun test tests/auth.test.ts`.
- **Typecheck**: `bunx tsc --noEmit` must pass before committing.
- **Test style**: `bun:test` against the exported `app` from `src/index.ts`
  (`app.handle()`), injecting fresh in-memory stores for determinism and asserting on
  the `{ success, message, data, errors }` envelope.
- **Live E2E**: against a running `bun run dev` with Postgres, use the REST-client
  flow suites in `docs/http/`:
  `npx --yes httpyac docs/http/09-chat-sync-flow.http -e local --all`.