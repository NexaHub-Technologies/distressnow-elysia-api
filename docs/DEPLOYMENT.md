# DEPLOYMENT.md — Running & shipping

Source of truth: `docker-compose.yml`, `package.json` scripts, `README.md` quickstart,
`.env.example`, `drizzle.config.ts`.

## Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| **Bun** | ≥ 1.x (`oven/bun:1` Docker image) | Runtime, bundler, test runner, package manager |
| **Postgres** | 16 (or compatible) | Local install, Docker, or hosted (Neon, Supabase, RDS, …) |

No Node.js or npm required — Bun covers everything.

## Local development bootstrap

```bash
# 1. Install dependencies
bun install

# 2. Environment — copy the template and fill in keys (see INTEGRATIONS.md)
cp .env.example .env
# DATABASE_URL and JWT_SECRET have sane defaults for local Postgres;
# Termii / Resend / Cloudinary / Paystack / Expo keys are all optional
# (absent → mock mode, see INTEGRATIONS.md).

# 3. Start Postgres (pick one)
docker compose up -d postgres          # Postgres 16-alpine on :5432
# — or —
# point DATABASE_URL at an existing Postgres instance

# 4. Schema — push or migrate (pick one)
bun run db:push                        # quick: drizzle-kit push (dev)
# — or —
bun run db:generate                    # generate SQL into drizzle/
# bun run db:migrate                   # apply journaled migrations

# 5. Seed (idempotent; safe to re-run)
bun run db:seed

# 6. Dev server with hot-reload
bun run dev                            # bun run --watch src/index.ts
# API on http://localhost:3000
# Swagger docs at http://localhost:3000/docs
# Health check at http://localhost:3000/health
```

## Production-ish run (Docker Compose)

`docker-compose.yml` defines two services:

- **`postgres`** — `postgres:16-alpine`, user/password/db `postgres/postgres/distressnow`,
  data persisted in a named volume `pgdata`.
- **`api`** — `oven/bun:1`, depends on `postgres`, reads `.env` via `env_file`,
  command `bun run --watch src/index.ts`, exposed on port **3000**.

```bash
docker compose up --build          # builds Bun image, starts Postgres + API
docker compose exec api bun run db:push   # push schema (first time)
docker compose exec api bun run db:seed   # seed data
```

Health check: `GET /health` → `{ success: true, message: "Healthy.", data: { status: "ok" } }`.

Swagger docs served at `GET /docs` (bundled `@elysiajs/swagger`).

> The compose file mounts the source tree into the container — this is a
> *development/staging* compose. For production use a multi-stage Dockerfile with a
> `bun run build` step and a non-`--watch` `bun run start` command.

## `package.json` script inventory

| Script | Command | What it does |
|---|---|---|
| `dev` | `bun run --watch src/index.ts` | Hot-reloading dev server (Elysia + cors + swagger) |
| `start` | `bun run src/index.ts` | Production-ish start (no watch) |
| `db:generate` | `drizzle-kit generate` | Diff `src/db/schema.ts` vs last migration → write new SQL to `drizzle/` |
| `db:push` | `drizzle-kit push` | Sync schema straight to `DATABASE_URL` (fast dev shortcut, non-journaled) |
| `db:migrate` | `drizzle-kit migrate` | Replay journalled migrations in `drizzle/` |
| `db:seed` | `bun run src/db/seed.ts` | Seed roles, categories, states, markets, staff users (idempotent upserts) |
| `test` | `bun test` | Run 131 tests across 6 suites (no DB required) |

## Migration workflow

The drizzle schema is the source of truth; never hand-edit SQL in `drizzle/`.

```text
src/db/schema.ts  (edit)  →  bun run db:generate  →  drizzle/NNNN_*.sql  (review)
                                                            ↓
                                          bun run db:generate  (next change)
                                          bun run db:migrate   (CI / prod)
                                          bun run db:push      (local dev)
```

`drizzle.config.ts` settings:
- `dialect: "postgresql"`, `schema: "./src/db/schema.ts"`, `out: "./drizzle"`.
- `DATABASE_URL` defaults to `postgres://postgres:postgres@localhost:5432/distressnow`
  (override via `DATABASE_URL` env var — `drizzle-kit` reads it directly from
  `process.env` in the config).

## Environment checklist

| Variable | Required? | Default | Notes |
|---|---|---|---|
| `DATABASE_URL` | Yes | `postgres://postgres:postgres@localhost:5432/distressnow` | All DB-backed routes fail without it; `/health` and in-memory routes still respond |
| `JWT_SECRET` | Yes | `dev-secret-change-me` | 7-day HS256 JWT (signs `sub` + `roles`); set a long random string in prod |
| `PORT` | No | `3000` | Bind port |
| `RESEND_API_KEY` | Optional | `""` (mock) | Email service — absent → mock mode |
| `RESEND_FROM` | Optional | `no-reply@distressnow.com` | Sender address |
| `TERMII_API_KEY` | Optional | `""` (mock) | SMS OTP — absent → mock mode |
| `TERMII_SENDER_ID` | Optional | `DistressNow` | Sender id for Termii |
| `TERMII_BASE_URL` | Optional | `https://api.ng.termii.com` | |
| `CLOUDINARY_CLOUD_NAME` | Optional | `""` (mock) | Media uploads — absent → mock mode |
| `CLOUDINARY_API_KEY` | Optional | `""` (mock) | |
| `CLOUDINARY_API_SECRET` | Optional | `""` (mock) | |
| `PAYSTACK_SECRET_KEY` | Optional | `""` (mock) | Payments — absent → mock mode |
| `PAYSTACK_SECRET` | Optional | `""` (legacy alias) | `PAYSTACK_SECRET_KEY` takes precedence |
| `PAYSTACK_PUBLIC_KEY` | Optional | `""` | Client-side public key |
| `EXPO_ACCESS_TOKEN` | Optional | `""` | Push delivery (Bearer token) |

See `docs/INTEGRATIONS.md` for additional process.env-only flags (`EXPO_PUSH_ENABLED`,
`PAYSTACK_CURRENCY`).

## Behavior when the database is unreachable

- Routes backed by Postgres (categories, listings, stores, chat archive, bookings,
  support, …) return **500**.
- `/health`, `/api/v1/`, `/api/v1/adverts/active` (in-memory advert store), and all
  `/api/v1/auth/*` routes **respond** — the auth/KYC/application plugins fall back to
  in-memory stores (see `src/db/stores.ts` "boot-time auto-detect" in
  `docs/DATABASE.md`).
- A single `console.warn` is logged at boot; subsequent requests use the fallback path
  silently.

## Swagger docs

`@elysiajs/swagger` is served at **`GET /docs`** — available in any environment
(including when Postgres is down). The Swagger config mirrors the description from
`src/index.ts` and auto-documents all registered Elysia routes.