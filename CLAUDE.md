# DistressNow API (Elysia rebuild) — Development Guide

Full repository guidelines live in **`AGENTS.md`** — read it first. This file adds the Bun/CLI conventions that are easy to trip on.

## Project context

`distressnow-elysia-api` is a **Bun + Elysia + Postgres** port of the Laravel 11 `DistressNowApi`.
All routes under `/api/v1`, response envelope `{ success, message, data, errors }`, JWT auth,
DB-backed stores with in-memory fallback, and mock-mode external services (Termii, Resend,
Cloudinary, Expo Push, Paystack). See `AGENTS.md`, `docs/ARCHITECTURE.md`, and `docs/API.md`.

## Bun conventions (defaults)

- Use `bun <file>` instead of `node <file>` / `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` / `yarn` / `pnpm`
- Use `bun run <script>` instead of `npm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads `.env` — don't use `dotenv`.
- `package.json` scripts (never use raw `npx tsc`):
  - `bun run dev` — start with hot reload
  - `bun run start` — production entry
  - `bun run db:generate` / `db:push` / `db:migrate` / `db:seed`
  - `bun test` — test suite
  - `bunx tsc --noEmit` — typecheck gate (must pass before commit)

## Project gotchas

- **Elysia 1.4**: `error()` is removed from handler context — use `status(code, body)`.
  `status(201)` alone is a no-op; `status(n, body)` must be returned.
- **Drizzle**: `.where()` takes a single condition — use `and(...)` for multiple.
- **Auth guard**: full JWT derive is applied in auth/kyc/applications; several modules
  (admin, media, payments, chat, notifications, support, adverts, referrals, safety)
  still use the `x-user-id` / `x-user-role` header stub — migrate to the real guard
  when the auth plugin can propagate.
- **DB-backed stores**: `src/db/stores.ts` auto-detects a reachable `DATABASE_URL` at
  boot and falls back to in-memory stores otherwise. Tests use the in-memory path;
  live E2E uses Postgres via `bun run dev`.

## Testing

- `bun test` — 131 tests / 6 suites (auth, kyc, marketplace, engagement, payments, admin).
- New features: `bun:test` against the exported `app` from `src/index.ts`
  (`app.handle()`), inject fresh in-memory stores, assert on the envelope.
- Live E2E: `npx --yes httpyac docs/http/01-auth-and-otp-flow.http -e local --all`