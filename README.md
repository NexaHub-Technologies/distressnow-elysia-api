# DistressNow API — Elysia + Bun + Postgres

Port of the Laravel 11 `DistressNowApi` backend to **Bun + Elysia + Postgres** (drizzle-orm + postgres-js).
Email via **Resend**, SMS/OTP via **Termii**, media via **Cloudinary**, push via **Expo Push**, payments via **Paystack**.

- Source parity reference (read-only): `/home/mich/Projects/DistressNowApi` (`routes/api.php`, 32 Eloquent models, 35+ migrations)
- API prefix parity: all routes under `/api/v1` — same paths/verbs as Laravel
- Docs: Swagger at `/docs`, health at `/health`

## Documentation index

| Doc | What's in it |
|---|---|
| [docs/API.md](docs/API.md) | API routes & endpoints |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | High-level architecture overview |
| [docs/DATABASE.md](docs/DATABASE.md) | Postgres data model — 38 tables, enums, indexes, seeding, DB-backed stores |
| [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md) | External services — Termii, Resend, Cloudinary, Expo Push, Paystack |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Running & shipping — Docker, migrations, env checklist |
| [docs/TESTING.md](docs/TESTING.md) | Test strategy — how to run, suite inventory, writing new tests |
| [docs/http/](docs/http/) | HTTP reference (curl/httpyac examples) |

## Quickstart

```bash
bun install
cp .env.example .env   # fill DATABASE_URL, JWT_SECRET, RESEND_*, TERMII_*, CLOUDINARY_*, PAYSTACK_*
docker compose up -d postgres   # or point DATABASE_URL at existing Postgres
bun run src/index.ts            # dev: bun run --watch src/index.ts
```

DB schema (drizzle, 38 tables mirroring Laravel migrations):

```bash
bun run db:generate   # drizzle-kit generate
bun run db:push       # push to DATABASE_URL
bun run db:migrate    # apply migrations
```

Tests / typecheck:

```bash
bun test              # 131 tests across 6 files (auth, kyc, marketplace, engagement, payments, admin)
bunx tsc --noEmit
```

## Structure

```
src/
  index.ts            # app entry: cors, /docs, /health, mounts all modules under /api/v1
  env.ts              # zod-typed env (DATABASE_URL, JWT_SECRET, RESEND_*, TERMII_*, CLOUDINARY_*, PAYSTACK_*, EXPO_*)
  db/{client,schema}.ts  # postgres-js + drizzle singleton, full schema (bigint PK + uuid public id, Laravel parity)
  plugins/{auth,errors}.ts  # JWT derive (currentUser/userRoles), requireAuth, requireRole(admin|verifier), requireKyc(1|2), notSuspended; {success,message,data,errors} envelope
  modules/
    auth/             # POST /auth/register|login|otp/send|otp/verify|social/:provider|password/*, GET/PATCH /auth/me, POST /auth/logout
    kyc/              # GET /kyc/status, POST /kyc/submit (multipart, Cloudinary)
    applications/     # seller (kyc:2) + provider (kyc:1) status + submit
    catalog/          # GET /categories, /locations/states, /locations/markets
    stores/           # directory + manage + follows
    providers/        # directory + update + bookings + contact-updates
    listings/         # feed, /deals, CRUD, images, promote, click/view, favorite, recently-viewed
    search/           # GET /search (listings+stores+providers)
    bookings/         # buyer/provider lists, status transitions
    reviews/          # GET/POST /reviews
    saved-searches/   # GET/POST/DELETE /user/saved-searches
    chat/             # POST /chat/sync|presence, GET /chat/conversations|:id, POST /:id/read (Firebase RTDB stays realtime; API is archive+presence)
    notifications/    # feed, push-token register/delete, read-all, :id/read
    support/          # tickets CRUD + reply + status
    adverts/          # GET /adverts/active, POST /adverts
    referrals/        # POST /referrals/register|attribution
    safety/           # POST /reports/safety
    payments/         # POST /payments/initialize|verify|webhook (HMAC-SHA512 raw-body check)
    media/            # POST /media/upload (Cloudinary)
    admin/            # /admin dashboard/stats, kyc + application + advert + listing review, users, markets, support triage, broadcasts, feature
  services/           # termii.ts (Termii fetch + mock), email.ts (Resend + mock), storage.ts (Cloudinary + mock), push.ts (Expo + mock), paystack.ts (+ mock)
  utils/              # response envelope + pagination, phone (080…→+234…), password (Bun.password), slugify, lookups, marketplace filters
```

## Integrations & mock modes

All external services degrade to logged mock-mode when keys are absent (tests deterministic):
- **Resend**: `RESEND_API_KEY`/`RESEND_FROM` — verification, password-reset, KYC decision mails
- **Termii**: `TERMII_API_KEY`/`TERMII_SENDER_ID`/`TERMII_BASE_URL` — 6-digit OTP, 10-min TTL, hashed storage, 5 attempts
- **Cloudinary**: `CLOUDINARY_CLOUD_NAME`/`API_KEY`/`API_SECRET` — `uploadBuffer(buf,{folder})→{url,path}`, KYC docs + listing images
- **Expo Push**: chunked POST to `exp.host`, dead-token pruning
- **Paystack**: init/verify via `api.paystack.co`, webhook HMAC-SHA512 verification on raw text body

## Notes

- JWT: `{sub, roles}`, 7-day expiry (Sanctum parity). Auth / KYC / applications default to Postgres-backed stores (`src/db/stores.ts`, over `users` / `otp_codes` / `kyc_profiles` / `seller_applications` / `provider_applications`) while `DATABASE_URL` is reachable, and fall back to the in-memory singletons when it is not (one warning logged on connect failure). Tests pin explicit in-memory stores via plugin options. Public user ids are `String(users.id)` — the `users` table has no `uuid` column; the DB OTP store persists the plain code (`otp_codes.code` is varchar(10)) with the same TTL/attempt/single-use semantics as the memory store.
- Chat `conversation_id` is the client's Firebase key (not the access check) — same contract as Laravel `ChatMessage::visibleTo()`.
- Without a live `DATABASE_URL`, DB-backed routes (categories, listings, stores…) return 500; `/health`, `/api/v1/`, `/api/v1/adverts/active` (in-memory) respond without DB.
