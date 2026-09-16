# TESTING.md — Test strategy

Source of truth: `tests/*.test.ts` (6 files), `package.json` test script,
CLAUDE.md conventions.

## Running the suite

```bash
bun test                   # run all 131 tests across 6 files (~4 s, no DB required)

bun test tests/auth.test.ts        # single file
bun test tests/kyc.test.ts         # single file
# …etc.
```

`bun test` uses Bun's built-in test runner (`bun:test`); no Jest or Vitest.

As of the current codebase: **131 tests, 433 `expect()` calls, 0 failures**.

## Suite inventory

| File | Describe blocks | What it covers |
|---|---|---|
| `auth.test.ts` | `normalizePhone`, `OTP helpers`, `password hashing (Bun.password)`, `POST /api/v1/auth/register`, `POST /api/v1/auth/login`, `authenticated /me + logout`, `OTP send/verify + password reset` | Phone normalization (080…→+234…, spaces/dashes/brackets, strip-less-than-zero), OTP code shape (6-digit numeric), SHA-256 OTP hash determinism, `MemoryOtpStore` issue/verify round-trip / wrong-code rejection / expiry / single-use, bcrypt round-trip, register (email + phone, duplicate 409, 422 without credential), login (email / phone, wrong-password 401), authenticated `/me` (anonymous 401), PATCH `/me`, logout revokes token, phone OTP verify creates new user + returns JWT, bad code 422, full password-reset flow (check-phone → send-reset → reset → login). |
| `kyc.test.ts` | `GET /api/v1/kyc/status`, `POST /api/v1/kyc/submit`, `role applications` | KYC status for anonymous/authenticated users with no profile, multipart submit via `FormData` (mock Cloudinary — storage:mock logged), tier-1 identity-only and tier-1 + tier-2 business paths, duplicate/KYC-in-progress 403, application guard: provider requires approved tier-1 KYC (403 before, 201 after), duplicate pending provider 409, seller requires approved tier-2 KYC, required field validation 422, `status: null` when no application exists. |
| `marketplace.test.ts` | `normalizeListingFilters (filter query builder)`, `pagination envelope`, `slugify`, `rating validation`, `deal + promotion rules`, `misc helpers` | Pure helpers only (no HTTP): filter normalisation (category slug, state, price range, keyword, deal type, sorting, promotion), pagination envelope shape, `slugify` (spaces, unicode, punctuation), `validateRating` (1–5 int only), deal/promotion rules (discount requires original price, future expiry, featured-then-promoted guard), `removeUndefined`, `pickRandom`. |
| `engagement.test.ts` | `chat conversations`, `support tickets`, `expo push`, `notifications`, `adverts`, `referrals`, `safety reports` | Chat store helpers (key generation, conversation key creation, unread counts), support ticket creation/listing/status-change/reply/assign, Expo push unit tests (`chunk`, `buildExpoMessages`, `extractDeadTokens` prune `DeviceNotRegistered`/`InvalidCredentials`), in-memory notification feed + mark-read, advert creation/expiry check, referral registration + attribution, safety-report validation + store + idempotent reject duplicate pending. |
| `payments.test.ts` | `webhook signature verification`, `gateway status mapping`, `paystack mock mode`, `payments routes` | HMAC-SHA512 webhook verification (valid signature, tampered body fails, empty inputs fail), `mapGatewayStatus` (success/failed/reversed/abandoned/pending), `isMockMode` (empty string → true, non-empty → false), mock `initializeTransaction` returns checkout URL, mock `verifyTransaction` returns success, register + auth guard (401 without token), initialize flow (creates transaction + returns authorization_url), verify flow (updates status), webhook flow (charges success). |
| `admin.test.ts` | `role guard logic`, `dashboard stats`, `kyc review`, `application review`, `user management`, `markets crud`, `support queue + contact updates`, `adverts`, `listings review + featuring`, `notification broadcasts` | Admin plugin wired with multi-role user store: `requireRole("admin")` rejects 401/403/422 edge cases, dashboard stats return zeros for empty DB, KYC review approve/reject + duplicate-status 409, seller and provider application approve/decline + already-reviewed 409, user list/search (empty results, email search), suspend user, market CRUD (list, create with duplicate-slug conflict, update, toggle active), support ticket list + assign + reply + status change, advert admin CRUD + expired filtering, listing review (approve/reject/feature/unfeature) + promote, broadcast create + audience resolution + send log. |

## Testing conventions

### Envelope assertions

Every route returns the standard API envelope:

```json
{ "success": true, "message": "...", "data": { ... }, "errors": null }
```

Tests assert `res.json['success']` / `res.json['data']` — helper `dataOf(res)` extracts
the `data` object. 4xx errors return `success: false` with `data: null`.

### Fresh stores per test

Each `buildApp()` helper creates **new** in-memory stores and wires them into the
relevant plugin factory:

```ts
const users = new MemoryUserStore();
const otp   = new MemoryOtpStore();
const kyc   = new MemoryKycStore();
const sellers = new MemorySellerApplicationStore();
const providers = new MemoryProviderApplicationStore();
const app = new Elysia()
  .use(createAuthPlugin({ secret: SECRET, users, otp }))
  .use(createKycPlugin({ secret: SECRET, users, kyc }))
  .use(createApplicationsPlugin({ secret: SECRET, users, kyc, sellers, providers }));
```

This keeps every test fully isolated — no shared state, no DB, no seed required.

### `app.handle()` pattern

Tests exercise HTTP routes via Elysia's in-process handler:

```ts
const res = await app.handle(
  new Request('http://localhost/api/v1/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  }),
);
const json = (await res.json()) as Record<string, unknown>;
expect(res.status).toBe(201);
expect(json['success']).toBe(true);
```

Auth tokens are obtained by registering/logging in within the test and passed via the
`Authorization: Bearer` header.

### Mock-mode services

Because `RESEND_API_KEY`, `TERMII_API_KEY`, `CLOUDINARY_*`, `PAYSTACK_SECRET_KEY`, and
`EXPO_ACCESS_TOKEN` are all empty in the test environment (`.env` is gitignored), every
external service runs in mock mode. Tests can therefore verify:

- Email sends are logged (`[email:mock]`) but never dispatched.
- SMS sends are logged (`[termii:mock]`) but never dispatched.
- File uploads return deterministic mock URLs (`[storage:mock]`) — no real Cloudinary
  call.
- Paystack initialize/verify return mock payloads with `mock: true`.

The HTTP route tests (payments, admin) mock at the *route level* using the in-memory
stores — they never hit a real gateway.

## Writing a new test

```ts
// tests/my-feature.test.ts
import { describe, expect, test } from 'bun:test';
import { Elysia, type AnyElysia } from 'elysia';
import { createMyPlugin } from '../src/modules/my-feature/index';

const SECRET = 'test-secret-my-feature';

function buildApp(): AnyElysia {
  const users = new MemoryUserStore();
  const otp = new MemoryOtpStore();
  return new Elysia()
    .use(createAuthPlugin({ secret: SECRET, users, otp }))
    .use(createMyPlugin({ secret: SECRET }));
}

// Helper: POST helper
async function post(app: AnyElysia, path: string, body: unknown, token?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await app.handle(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    }),
  );
  const json = (await res.json()) as Record<string, unknown>;
  return { status: res.status, json };
}

describe('my feature', () => {
  test('returns 201 with correct envelope', async () => {
    const app = buildApp();
    // register first (get a token)
    const reg = await post(app, '/api/v1/auth/register', {
      name: 'Test', email: 'test@example.com', password: 'password1',
    });
    const token = (reg.json['data'] as Record<string, unknown>)['token'] as string;

    const res = await post(app, '/api/v1/my-feature', { /* body */ }, token);
    expect(res.status).toBe(201);
    expect(res.json['success']).toBe(true);
    expect(res.json['data']).toBeDefined();
  });
});
```

Checklist for a new test file:
1. Import from `bun:test` only — no Jest, no Vitest.
2. Build a fresh `app` via `buildApp()` using in-memory stores.
3. Register / log in a user to get a JWT when testing authenticated routes.
4. Use `app.handle(new Request(...))` — never spin up a real HTTP server.
5. Assert the envelope shape (`success`, `data`, `message`).
6. Run `bun test tests/my-feature.test.ts` before committing.

## Typecheck

```bash
bunx tsc --noEmit   # full-project type check (CI-friendly)
```

The project targets TypeScript 7+ (`tsconfig.json`; `peerDependencies.typescript: "^7"`).
Run this after any schema/interface change — the drizzle-generated types are inferred at
compile time.

## E2E against live Postgres

Unit tests do not touch the database. For full-stack validation against a running API:

```bash
# Terminal 1
docker compose up postgres        # or local Postgres
bun run db:push && bun run db:seed
bun run dev                       # API on :3000

# Terminal 2
# Manual curl / httpyac tests against the live routes
# Example:
httpyac :3000/api/v1/auth/register POST
Content-Type: application/json

{
  "name": "E2E User",
  "email": "e2e@test.com",
  "password": "e2e12345"
}
```

This is the recommended path for testing webhook flows, multipart uploads,
database-backed stores, and seed data — all of which are beyond the scope of the
in-memory unit suite.