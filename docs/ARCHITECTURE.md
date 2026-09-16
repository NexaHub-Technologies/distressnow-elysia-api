# DistressNow API — Architecture

A **Bun + Elysia + Postgres** port of the Laravel 11 `DistressNowApi` backend.
Same route surface (`/api/v1/...`), same response envelope, same domain model —
rebuilt on a far smaller codebase (47 files vs 226; ~13.7k vs ~43.7k lines
excluding vendored dependencies).

- Reference (read-only): `/home/mich/Projects/DistressNowApi`
- Related apps: `Distressnow-App` (Expo / React Native client), `DistressNow` (legacy web)
- Docs: Swagger UI at `/docs`; full endpoint reference in `docs/API.md`

## Topology

```
                   ┌────────────────────────────────────────────────┐
                   │                Elysia app (:3000)              │
                   │  src/index.ts                                  │
                   │  cors · swagger(/docs) · global error handler  │
                   │  GET /health · .group('/api/v1')               │
                   └───────┬──────────────────────────┬─────────────┘
                           │ full-prefix mounts       │ group mounts
           ┌───────────────┴─────────┐   ┌────────────┴──────────────┐
           │ auth · kyc ·            │   │ catalog · search ·        │
           │ applications · admin ·  │   │ listings · stores ·       │
           │ media · payments        │   │ providers · bookings ·    │
           │ (declare /api/v1/...)   │   │ reviews · saved-searches ·│
           └───────────────┬─────────┘   │ adverts · chat ·          │
                           │             │ notifications · support · │
                           │             │ referrals · safety        │
                           │             └────────────┬──────────────┘
                           ▼                           ▼
              ┌────────────────────────────────────────────────────┐
              │   src/plugins    src/services        src/utils     │
              │   auth (JWT)     termii · email       envelope     │
              │   errors         storage · push       pagination   │
              │                  paystack             phone ·      │
              │                                       password ·   │
              │                                       slugify ·    │
              │                                       lookups      │
              └────────────────────────┬───────────────────────────┘
                                       ▼
              ┌────────────────────────────────────────────────────┐
              │   src/db  (drizzle-orm + postgres-js)              │
              │   schema.ts   → 38 tables (single source of truth) │
              │   client.ts   → postgres pool singleton            │
              │   stores.ts   → DB-backed User/Otp/Kyc/App stores  │
              │   seed.ts     → master data (categories, states,   │
              │                 sublocations, 2,613 markets, roles,│
              │                 staff users)                       │
              └────────────────────────────────────────────────────┘
                                       ▼
                              PostgreSQL 16 (distressnow)
```

## Layer responsibilities

| Layer | Location | Responsibility |
|---|---|---|
| **Entry** | `src/index.ts` | Assemble the app: CORS, Swagger (`/docs`), error plugin, `/health`, mount all modules under `/api/v1`. Exports `app` without listening so `bun:test` can import it (`import.meta.main` guards the listen). |
| **Modules** | `src/modules/<domain>/index.ts` | Routes + TypeBox validation + domain logic + data access fused into one file per domain. Modularity keeps each unit small and swappable. |
| **Plugins** | `src/plugins/` | Cross-cutting concerns: `auth.ts` (JWT verify → `currentUser`, `requireAuth`, `notSuspended`, `requireRole`, `requireKyc`), `errors.ts` (global error → consistent envelope). |
| **Services** | `src/services/` | Thin clients for external suppliers with **mock-mode** degradation when keys are absent: `termii.ts`, `email.ts` (Resend), `storage.ts` (Cloudinary), `push.ts` (Expo), `paystack.ts`. |
| **DB** | `src/db/` | `schema.ts` (drizzle schema, generates the 749-line SQL migration), `client.ts` (postgres-js singleton), `stores.ts` (Postgres stores w/ in-memory fallback), `seed.ts` (master data). |
| **Utils** | `src/utils/` | Pure helpers: response envelope, pagination, phone normalization (`080…`→`+234…`), password hashing (Bun.password bcrypt), slugify, lookups (uuid/slug→PK resolvers). |

## Request lifecycle

1. Request hits Elysia → CORS, then body/query validated by the route's **TypeBox** schema (422 with `errors` on failure).
2. Guards run (`requireAuth` / `notSuspended` / `requireRole` / `requireKyc`, or the documented `x-user-id`/`x-user-role` header stub for modules not yet on the JWT derive).
3. Handler executes against a store — the **DB-backed store** (`src/db/stores.ts`) when `DATABASE_URL` is reachable (auto-probed at boot), otherwise in-memory.
4. Response built via `ok()` / `created()` / `fail()` envelope; errors flow through the global handler → consistent `{ success, message, data, errors }`.

## Authentication & authorization

- **Register / login / OTP / social / password-reset** (module `auth`) issue a **JWT** (`{ sub, roles }`, 7-day expiry) — parity with Laravel Sanctum tokens.
- **Roles** (admin, verifier, shop_manager, seller, provider, buyer) live in the `roles` + `model_has_roles` tables (spatie-permission shape).
- **KYC tiers**: `requireKyc(1)` for provider applications, `requireKyc(2)` for seller applications/stores; downgrade of an approved profile is blocked.
- **Suspension**: `notSuspended` returns 403 + reason.
- **Admin surface**: `role:admin|verifier` guards the review queues; `role:admin` only for suspend/unsuspend/assign-role/feature/broadcast.
- **Stub legacy**: admin, media, payments, chat, notifications, support, adverts, referrals, safety currently authenticate via `x-user-id` / `x-user-role` headers (defaulting user `1` where nothing is provided). Migrating these to the real JWT derive is the main auth-debt item.

## Data model (38 tables)

Shaped by domain — see `src/db/schema.ts` and `docs/DATABASE.md`:

- **Identity & roles** — users (+ presence/suspension columns), otp_codes, password_reset_tokens, roles/permissions/morph pivots
- **Verification & applications** — kyc_profiles, seller_applications, provider_applications
- **Catalog & location** — categories/subcategories, states/sublocations/markets
- **Marketplace** — stores/store_follows, service_providers, listings/listing_images, bookings, reviews, favorite_listings, recently_viewed_listings, saved_searches
- **Engagement** — chat_messages, notifications/device_tokens/notification_broadcasts, support_tickets/support_messages, adverts, referral_attributions, safety_reports
- **Money & ops** — transactions, admin_logs

Conventions: bigserial PK + `uuid` public id on the public-facing rows (Laravel parity — `users` uses its bigint id as the public id), `timestamptz` timestamps, jsonb for flexible fields (interests, category_specific_fields, documents, opening_hours, social_links), pg enums for statuses.

## Key parity & divergence notes vs Laravel

| Aspect | Laravel | Elysia rebuild |
|---|---|---|
| Routes | `routes/api.php`, all under `/api/v1` | Same paths via 20 module files |
| Response shape | JSON resources | Unified `{success,message,data,errors}` envelope everywhere |
| Auth | Sanctum bearer token | JWT `{sub, roles}` 7-day; same guards (roles, KYC tiers, suspension) |
| Emails | Laravel Mail (SMTP) | Resend |
| SMS/OTP | Termii via `TermiiService` | `src/services/termii.ts` (same API, mock-mode) |
| Media | `FileUploadService` → local disk / AWS S3 | Cloudinary (`src/services/storage.ts`) |
| Chat realtime | Firebase RTDB + Laravel archive endpoints | Firebase RTDB stays the realtime layer; API is archive + presence |
| Migrations | 36 PHP files (1,748 lines) | 1 `schema.ts` (1,118 lines) → generated SQL |
| Master data | Seeders incl. 23,587-line `MarketSeeder.php` | `src/db/data/markets.json` (one line) + `db:seed` |
| Config | 14 `config/*.php` files | `src/env.ts` zod-driven |
| Tests | PHPUnit (34 files) | `bun:test` (6 files, 131 tests) |

## Integrations & mock modes

All `src/services/*` clients detect missing credentials and fall back to **log-only mock mode** so the whole app runs offline:

- **Termii** — `TERMII_API_KEY/SENDER_ID/BASE_URL`; `sendOtp`/`sendSms` → `api.ng.termii.com/api/sms/send`; OTPs: 6-digit, 10-min TTL, 5 attempts, hashed (DB store persists plain code per Laravel parity)
- **Resend** — `RESEND_API_KEY/FROM`; verification / password-reset / KYC-decision templates
- **Cloudinary** — `CLOUDINARY_*`; `uploadBuffer` → `{url, path}` [path = public_id], KYC docs, listing images, adverts, `POST /media/upload`
- **Expo Push** — `EXPO_ACCESS_TOKEN`, `EXPO_PUSH_ENABLED`; 100-per-chunk fan-out, dead-token pruning
- **Paystack** — `PAYSTACK_SECRET_KEY/PUBLIC_KEY`; initialize/verify + HMAC-SHA512 webhook verification on the **raw text body**

## Testing

- `bun test` — 131 tests / 433 expects across 6 suites (auth, kyc, marketplace, engagement, payments, admin) via `app.handle()` against the exported app, with fresh in-memory stores injected.
- `bunx tsc --noEmit` — typecheck gate.
- Live E2E — REST-client flows in `docs/http/` (11 flows) against `bun run dev` + Postgres.

## Deployment topology

- `docker-compose.yml`: `postgres:16-alpine` + `oven/bun:1` API service (`env_file: .env`).
- Local: `bun install` → `cp .env.example .env` → `db:push` → `db:seed` → `bun run dev`.
- Migration workflow: edit `src/db/schema.ts` → `bun run db:generate` → review `drizzle/*.sql` → `db:migrate`.
- Health check: `GET /health`; API docs: `GET /docs`.

See `docs/DEPLOYMENT.md` for the full runbook and env checklist.