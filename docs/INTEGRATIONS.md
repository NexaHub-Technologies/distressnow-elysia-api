# INTEGRATIONS.md — External services

The API talks to five external providers. Every one of them **degrades to mock mode**
(logged locally, no network, no billing) when its credentials are absent, so local dev
and the test suite are fully deterministic. Source of truth: `src/services/*.ts`,
`src/env.ts`, `.env.example`, and the call sites in `src/modules/*`.

All env vars below are read by `src/env.ts` (zod-validated, defaults shown). Two
flags — `EXPO_PUSH_ENABLED` and `PAYSTACK_CURRENCY` — are read directly from
`process.env` inside `src/services/push.ts` / `src/services/paystack.ts` and are *not*
part of the env schema (no `.env.example` entry either; both have built-in defaults).

---

## 1. Termii — SMS / OTP delivery (`src/services/termii.ts`)

**Purpose:** send verification codes and arbitrary SMS to Nigerian phone numbers, and
own the OTP lifecycle (10-minute TTL, max 5 attempts, single-use).

| Env var | Default | Notes |
|---|---|---|
| `TERMII_API_KEY` | `""` | Absent → mock mode |
| `TERMII_SENDER_ID` | `DistressNow` | `from` in the SMS payload |
| `TERMII_BASE_URL` | `https://api.ng.termii.com` | Trailing slashes stripped |

**How it's called:**
- `sendOtp(phone, code)` → `sendSms(to, message)`; message template:
  *"Your DistressNow verification code is {code}. It expires in 10 minutes."*
- `sendSms(phone, message)` — POST `{TERMII_BASE_URL}/api/sms/send` with JSON body
  `{ api_key, to, from: senderId, sms, type: "plain", channel: "generic" }`; returns
  `{ ok, mock, to, providerId? }` where `providerId` is `message_id` from the response.

**Mock mode:** no API key → the message is `console.log`ged and
`{ ok: true, mock: true, to }` returned. **Never throws** in mock mode; with a key
configured, a non-2xx response throws "Termii SMS request failed with status …".

**Call site:** `src/modules/auth/index.ts` — registration (fire-and-forget `phone_signup`
OTP), `POST /api/v1/auth/otp/send`, and the phone password-reset flow
(`phone_reset`) all route through `sendPhoneOtp` (`sendOtp`).

---

## 2. Email — Resend (`src/services/email.ts`)

**Purpose:** transactional mail — verification OTPs, password-reset OTPs, KYC decision
notices, plus a generic `send()`.

| Env var | Default | Notes |
|---|---|---|
| `RESEND_API_KEY` | `""` | Absent → mock mode |
| `RESEND_FROM` | `"DistressNow \<no-reply@distressnow.com\>"` | Sender string for every mail |

**How it's called:** a Resend client is constructed lazily
(`new Resend(RESEND_API_KEY)`) and `client.emails.send({ from, to, subject, html, text })`
is used. Public helpers:
- `send(options)` → `{ ok, mock, to, id? }` (`id` is Resend's message id)
- `sendVerification(email, code)` — "Verify your DistressNow account", 15-minute expiry
- `sendPasswordReset(email, code)` — "Reset your DistressNow password"
- `sendKycDecision(email, 'approved' | 'rejected', reason?)` — KYC review outcome

**Mock mode:** no API key → the message is logged and `{ ok: true, mock: true, to }`
returned. Throws only when a key *is* configured and Resend rejects the message.

**Call site:** `src/modules/auth/index.ts` (email OTP on register, `otp/send`,
`password/reset` via `sendVerificationEmail`/`sendPasswordResetEmail`) and the admin KYC
review flow (`sendKycDecision`).

---

## 3. Media storage — Cloudinary (`src/services/storage.ts`)

**Purpose:** central upload path for KYC documents, listing images, avatars, store
logos — the port of Laravel's `FileUploadService`.

| Env var | Default | Notes |
|---|---|---|
| `CLOUDINARY_CLOUD_NAME` | `""` | |
| `CLOUDINARY_API_KEY` | `""` | |
| `CLOUDINARY_API_SECRET` | `""` | |

**How it's called:**
- `uploadBuffer(data, { folder, filename?, contentType? })` → `{ url, path, public_id? }`
  via `cloudinary.uploader.upload_stream({ folder, public_id, resource_type: "auto" })`;
  `url` is `secure_url` (falls back to `url`), `path`/`public_id` are the Cloudinary
  public id.
- `uploadKycDoc(buffer, userId, slot, filename?)` → folder `kyc/<userId>/<slot>`.
- `uploadListingImage(buffer, listingId, filename?)` → folder `listings/<listingId>`.
- `deleteByPublicId(publicId)` → `cloudinary.uploader.destroy(publicId)`.

**Mock mode:** when **any** of the three credentials is missing,
`isMockMode()` is true: no network, deterministic
`https://res.cloudinary.com/{cloudName}/image/upload/{folder}/{publicId}` URL
(`cloudName` falls back to the literal `"mock"`), and uploads **resolve, never reject**.

**Call sites:** `src/modules/kyc/index.ts` (`POST /api/v1/kyc/submit` — multipart
documents via `uploadBuffer`), `src/modules/media/index.ts`
(`POST /api/v1/media/upload`), plus listing-image and store/logo uploads.

---

## 4. Push — Expo (`src/services/push.ts`)

**Purpose:** send push notifications to iOS/Android/web via Expo, and register/prune
device tokens.

| Env var | Default | Notes |
|---|---|---|
| `EXPO_ACCESS_TOKEN` | `""` | Sent as `Authorization: Bearer <token>` when present |
| `EXPO_PUSH_ENABLED` | `"true"` | **Not in env.ts/`.env.example`** — read directly from `process.env`; `false`/`0`/`no`/`off` → disabled |

**How it's called:**
- `sendPush(notification, tokens, opts?)` → `{ mocked, attempted, sent, pruned }`.
  Builds Expo messages (`{ to, title, body, sound: "default", data: { notification_id,
  type, ...data } }`), splits them into chunks of **100** (`EXPO_CHUNK_SIZE` — that's
  Expo's per-request limit) and POSTs each batch to
  **`https://exp.host/--/api/v2/push/send`**.
- Per-receipt dead-token pruning: `extractDeadTokens()` drops tokens whose error is
  `DeviceNotRegistered` or `InvalidCredentials` (`opts.store.prune(dead)`), so the
  registry doesn't fill with corpses.
- `DeviceTokenStore` — in-memory token registry (`register`/`remove`/`prune`/`forUser`);
  `sendNotification()` in `src/modules/notifications/index.ts` persists the in-app row
  then fans out to push **best-effort — never throws**; a dead Expo endpoint is logged
  and swallowed.

**Mock mode:** `EXPO_PUSH_ENABLED=false` → messages logged and
`{ mocked: true, attempted, sent: 0, pruned: [] }` returned; callers inject a
`fetchImpl`/`store` in tests.

**Call site:** `src/modules/notifications/index.ts` — `sendNotification` (used by chat,
bookings, reviews, support, payments, broadcasts, …) and the admin broadcast routes.

---

## 5. Payments — Paystack (`src/services/paystack.ts`)

**Purpose:** initialize and verify transactions and verify webhook signatures.

| Env var | Default | Notes |
|---|---|---|
| `PAYSTACK_SECRET_KEY` | `""` | **Canonical key** (matches Laravel `config/paystack.php`) |
| `PAYSTACK_SECRET` | `""` | **Legacy alias** — `PAYSTACK_SECRET_KEY || PAYSTACK_SECRET` is the resolved secret (`PAYSTACK_SECRET_RESOLVED`) |
| `PAYSTACK_PUBLIC_KEY` | `""` | Public key (client side) |
| `PAYSTACK_CURRENCY` | `"NGN"` | **Not in env.ts/`.env.example`** — read directly from `process.env` in `paystack.ts` |

Base URL is `https://api.paystack.co`. Allowed channels: `card`, `bank`, `ussd`, `qr`,
`mobile_money`, `bank_transfer`, `eft`, `opay`.

**How it's called:**
- `initializeTransaction({ email, amountKobo, reference, callbackUrl?, metadata?, channels? })`
  → POST `/transaction/initialize` with `{ email, amount, reference, channels, currency,
  callback_url?, metadata? }` *(amount is **kobo**; min ₦100 = 10000 kobo)* → returns
  `{ authorization_url, access_code, reference }`.
- `verifyTransaction(reference)` → GET `/transaction/verify/:reference` →
  `{ status, reference, amount, channel, gateway_response, paid_at, metadata,
  authorization, id }`; `mapGatewayStatus()` maps to
  `success | failed | reversed | pending`.
- `verifyWebhookSignature(payload, signature, secret?)` — **HMAC-SHA512** of the
  **raw request body** (byte-for-byte what Paystack sent) compared via
  `timingSafeEqual` against the `X-Paystack-Signature` header.

**Mock mode:** no secret (`PAYSTACK_SECRET_KEY` and `PAYSTACK_SECRET` both empty) →
no network. `initializeTransaction` returns a deterministic
`https://checkout.paystack.com/mock/{reference}` URL with `access_code: mock_{reference}`;
`verifyTransaction` returns a `success` payload with `mock: true`.
`verifyWebhookSignature` still behaves like the real thing (verifiable in tests).

**Call site:** `src/modules/payments/index.ts`:
- `POST /api/v1/payments/initialize` — creates a `transactions` row (`amount`,
  `amount_kobo`, `reference` from `generateReference()`) then calls
  `initializeTransaction`; failure flips the row to `failed` and returns 502.
- `POST /api/v1/payments/verify` — re-verifies a `pending` transaction via
  `verifyTransaction` and persists the mapped status + gateway fields.
- `POST /api/v1/payments/webhook` — route is declared `{ parse: "text" }` (raw body);
  rejects 401 when `verifyWebhookSignature` fails; on `charge.success` marks the
  matching pending transaction `success`.

---

## Secrets & key rotation

- **Local dev:** put every key in `.env` (copied from `.env.example`). `.env` is
  gitignored — **never commit it**. `.env.example` holds names + empty values only.
- **Containerized:** `docker-compose.yml` passes `env_file: .env` to the `api` service,
  so the same local file drives both local run and `docker compose` (compose overrides
  `DATABASE_URL`/`PORT` to point at the in-network Postgres).
- **Exact names** to set (from `src/env.ts`): `DATABASE_URL`, `JWT_SECRET`, `PORT`,
  `RESEND_API_KEY`, `RESEND_FROM`, `TERMII_API_KEY`, `TERMII_SENDER_ID`,
  `TERMII_BASE_URL`, `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`,
  `CLOUDINARY_API_SECRET`, `PAYSTACK_SECRET_KEY` (or legacy `PAYSTACK_SECRET`),
  `PAYSTACK_PUBLIC_KEY`, `EXPO_ACCESS_TOKEN`. Optionally `EXPO_PUSH_ENABLED` and
  `PAYSTACK_CURRENCY`.
- **Rotation:** update the value in `.env` (and in the secret manager of the deploy
  target) and restart — the services read `process.env` at call time (except the zod
  parse in `env.ts`, which runs once at import; restart after changing). `JWT_SECRET`
  rotation invalidates all sessions; prefer a fresh long random string and roll it
  during a maintenance window.
- **Missing-key behavior is safe by design:** any service absorbs the absence and runs
  in mock mode, so a partially-configured environment still boots and serves `/health`
  and the in-memory routes.