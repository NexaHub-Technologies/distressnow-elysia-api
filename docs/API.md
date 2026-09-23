# DistressNow API Reference

Complete route reference for the **DistressNow API** (`Bun + Elysia + Postgres` port of the Laravel 11 `DistressNowApi` backend).

Everything is served under the `/api/v1` prefix. Interactive docs are available too: Swagger UI at `/docs` (dev), health check at `/health`.

---

## 1. Overview

### Base URL

| Environment | Base URL |
|---|---|
| Local dev | `http://localhost:3000` (bind port from `env.PORT`) |
| All API routes | `http://localhost:3000/api/v1/...` |

### Authentication model

- **JWT bearer auth** — `Authorization: Bearer <token>`.
- Tokens are obtained from `POST /api/v1/auth/register` and `POST /api/v1/auth/login`, both of which return `{ token, user }`. OTP verify and social login also return tokens.
- JWT payload: `{ sub: <user id>, roles: string[] }`, **7-day expiry** (Sanctum parity), signed with `JWT_SECRET`.
- `POST /api/v1/auth/logout` revokes the presented bearer token (in-memory denylist).
- **Suspended users** are rejected with `403` by the full guard (`applyAuthGuard`: auth, KYC, applications) and by `POST /auth/login`. The marketplace modules derive the user from the JWT without a suspension check — suspension blocks those calls only where the handler logic itself rejects (e.g. login).

Two distinct guard styles are used across the codebase — check each endpoint's annotation:

| Guard style | Modules | Behaviour |
|---|---|---|
| **JWT derive / full guard** | auth, kyc, applications (full `applyAuthGuard`); listings, stores, providers, bookings, reviews, saved-searches (lighter `auth` derive) | 401 when no/invalid bearer token; 403 when suspended (full guard) |
| **Local header stub** (no JWT verification — sends the user id in request headers) | admin, media, payments, adverts, chat, notifications, support, referrals, safety | 401 when the required header is missing. **These modules do not verify the token.** |

Header-stub authentication details (the header actually required per module — do not guess):

- **admin** — `x-user-id` (required) + `x-user-role` (required for the role checks; single role or comma-separated list, e.g. `admin,verifier`) + `x-user-name` (optional). Staff = role `admin` **or** `verifier`; some routes are admin-only.
- **media** — `x-user-id` (required).
- **payments** — `x-user-id` (required) + `x-user-email` (optional; defaults to `<id>@example.com`).
- **adverts, chat, notifications, support, safety** — `x-user-id` (optional — **defaults to user id `1`** when missing), `x-user-role` (optional, `admin`/`verifier` widen visibility), `x-user-name` (optional).
- **referrals** — `x-user-id` optional; `POST /referrals/register` is callable anonymously (pre-signup), `POST /referrals/attribution` falls back to user id `1`.

### Content types

- `application/json` for all JSON bodies.
- `multipart/form-data` for file uploads: `POST /api/v1/kyc/submit`, `POST /api/v1/listings/:id/images`, `POST /api/v1/media/upload`.
- `POST /api/v1/payments/webhook` expects the **raw text body** of the Paystack payload (HMAC must cover the exact bytes).

### Response envelope

Every response uses the envelope (fields present even on errors):

```jsonc
{
  "success": true,          // or false
  "message": "OK",          // human-readable status message
  "data": { ... },          // payload; null on errors
  "errors": null            // validation detail / field errors; null when success
}
```

Paginated collections add a `meta` object:

```jsonc
{
  "success": true,
  "message": "OK",
  "data": [ ... ],
  "errors": null,
  "meta": {
    "current_page": 1,
    "per_page": 15,
    "total": 42,
    "last_page": 3
  }
}
```

Pagination query params: `page` (default 1) and `per_page` (default **15**, max **100**) for DB-backed lists; the in-memory modules (adverts, notifications, support) default `per_page` to **20** (capped 1–100) and report `total_pages` instead of `last_page`.

### Roles

Seeded roles (`bun run db:seed`): `admin`, `verifier`, `shop_manager`, `seller`, `provider`, `buyer` (every new user starts as `buyer`).

Seeded staff accounts (password `18781875`):

| Email | Role |
|---|---|
| `distressnow09@gmail.com` | admin |
| `distressadmin@gmail.com` | admin |
| `verifier@yopmail.com` | verifier |
| `shop-manager@yopmail.com` | shop_manager |
| `shopmanager@yopmail.com` | shop_manager |

KYC tiers: **Tier 1** (`kyc:1`) unlocks provider applications; **Tier 2** (`kyc:2`) unlocks seller applications. `GET /api/v1/kyc/status` reports the current `tier` (`0` until an approved submission exists).

---

## 2. Endpoint summary

| Module | Routes | Count |
|---|---|---|
| System (health, index) | `/health`, `/api/v1/` | 2 |
| Auth | `/api/v1/auth/*` | 13 |
| KYC | `/api/v1/kyc/*` | 2 |
| Applications | `/api/v1/applications/*` | 4 |
| Admin | `/api/v1/admin/*` | 40 |
| Media | `/api/v1/media/*` | 1 |
| Payments | `/api/v1/payments/*` | 3 |
| Catalog | `/api/v1/categories`, `/api/v1/locations/*` | 3 |
| Search | `/api/v1/search` | 1 |
| Listings | `/api/v1/listings/*`, `/api/v1/user/listings`, `/api/v1/user/favorites`, `/api/v1/user/recently-viewed` | 15 |
| Stores | `/api/v1/stores/*`, `/api/v1/user/store`, `/api/v1/user/stores`, `/api/v1/user/following`, `/api/v1/user/followed-stores` | 16 |
| View Tracking | `/api/v1/users/:id/view`, `/api/v1/user/profile/analytics`, `/api/v1/providers/:id/view`, `/api/v1/user/providers/:id/analytics` | 4 |
| Item Requests | `/api/v1/item-requests/*` | 7 |
| Providers | `/api/v1/providers/*` | 6 |
| Bookings | `/api/v1/bookings/*` | 3 |
| Reviews | `/api/v1/reviews` | 2 |
| Saved searches | `/api/v1/user/saved-searches` | 3 |
| Adverts | `/api/v1/adverts/*` | 2 |
| Chat | `/api/v1/chat/*` | 5 |
| Notifications | `/api/v1/notifications/*` | 8 |
| Support | `/api/v1/support/tickets` | 5 |
| Referrals | `/api/v1/referrals/*` | 2 |
| Safety | `/api/v1/reports/safety` | 1 |
| **Total** | | **143** |

> **Route-order notes that matter for clients.**
> - `GET /api/v1/listings/deals` is registered **before** `GET /api/v1/listings/:id` so `deals` is never treated as a UUID.
> - `GET /api/v1/providers/bookings` is registered **before** `GET /api/v1/providers/:id`.
> - `POST /api/v1/notifications/read-all` is registered **before** `POST /api/v1/notifications/:id/read`.
> - `GET /api/v1/chat/conversations` is registered **before** `GET /api/v1/chat/:conversationId`.

---

## 3. Endpoint reference (by module)

### 3.0 System

---

#### `GET /health`
Health check. Responds without a database.
- **Auth:** Public
- **Response:**
```jsonc
{ "success": true, "message": "Healthy.", "data": { "status": "ok" }, "errors": null }
```

---

#### `GET /api/v1/`
API version banner. Responds without a database.
- **Auth:** Public
- **Response:**
```jsonc
{ "success": true, "message": "DistressNow API v1.", "data": { "version": "v1" }, "errors": null }
```

---

### 3.1 Auth — `/api/v1/auth`

All responses use the envelope. Register / login / OTP-verify / social return `{ token, user }`. Unverified register also reports `{ requires_verification, channel }`. Registration/OTP dispatch fire-and-forget — they never fail registration.

Auth: the plugin's own JWT guard (`applyAuthGuard`). Protected routes return `401 Unauthenticated.` without a token and `403 Your account has been suspended. Contact support.` for suspended accounts.

---

#### `POST /api/v1/auth/register`
Create an account (email **or** phone, at least one required). Password is bcrypt-hashed. A verification OTP is dispatched to the chosen channel.
- **Auth:** Public
- **Body (JSON):**
  - `name` `string` (1–255) **required**
  - `email` `string` (email format, ≤255) optional
  - `phone` `string` (≤20, `080…` normalised to `+234…`) optional
  - `password` `string` (8–128) **required**
- **Success:** `201` `{ token, user, requires_verification, channel }` (`channel`: `"sms"` \| `"email"` \| `null`)
- **Errors:** `409` duplicate email/phone; `422` missing email+phone (the TypeBox schema or the explicit check).
```jsonc
{
  "success": true,
  "message": "Registration successful.",
  "data": {
    "token": "eyJhbGciOi...",
    "user": { "id": "1", "name": "...", "email": "a@b.com", "phone": null, "...": "..." },
    "requires_verification": true,
    "channel": "email"
  },
  "errors": null
}
```

---

#### `POST /api/v1/auth/login`
Log in with email, phone, or the `login` field (auto-detects email vs phone).
- **Auth:** Public
- **Body (JSON):**
  - `login` `string` (≤255) optional — identifier (email or phone)
  - `email` `string` (≤255) optional
  - `phone` `string` (≤20) optional
  - `password` `string` (1–128) **required**
- **Success:** `200` `{ token, user }`
- **Errors:** `401` bad credentials; `403` suspended account; `422` no identifier.

---

#### `POST /api/v1/auth/otp/send`
Send a 6-digit OTP. Email channel via Resend, phone via Termii.
- **Auth:** Public
- **Body (JSON):**
  - `phone` `string` (≤20) optional
  - `email` `string` (email format) optional
  - `type` one of `phone_signup | phone_reset | email_signup | email_reset` (default `phone_signup` or `email_signup` per channel)
- **Success:** `200` message with `{ email }` or `{ phone }`. Email OTPs expire in 15 minutes, phone OTPs in 10.
- **Errors:** `409` phone already registered (`phone_signup`); `404` no account (`phone_reset`); `422` no identifier / dispatch failure.

---

#### `POST /api/v1/auth/otp/verify`
Verify an OTP. A phone verify creates/logs-in a user and returns a token; an email verify marks the email verified.
- **Auth:** Public
- **Body (JSON):**
  - `phone` `string` (≤20) or `email` `string` (email format) — at least one
  - `code` `string` (exactly 6) **required**
  - `type` `OtpType` optional (default `phone_signup` / `email_signup`)
  - `name` `string` (≤255) optional — used when a phone verify creates a new account
  - `password` `string` (8–128) optional — optional password for a new phone account
- **Success:** email → `200` `{ token, user, ... }`; phone (existing) → `200` `{ is_new: false, token, user }`; phone (new) → **`201`** `{ is_new: true, token, user }`.
- **Errors:** `422` wrong/expired/locked code (single-use, 5 attempts), or no identifier.

---

#### `POST /api/v1/auth/social/:provider`
Social login with a verified id token.
- **Auth:** Public
- **Params:** `provider` `string` — `google` or `apple` (any other value → `422`)
- **Body (JSON):** `id_token` `string` or `token` `string` (at least one)
- **Behaviour:** Google tokens verified against `oauth2.googleapis.com/tokeninfo`; Apple tokens decoded locally (expiry + audience when `APPLE_CLIENT_ID` is set). Matching an existing email links the provider. New users are created with the provider's name/email.
- **Success:** `200` `{ is_new: bool, token, user }`
- **Errors:** `422` unsupported provider, missing token, or token verification failure.

---

#### `POST /api/v1/auth/password/check-phone`
Check whether a phone number has an account (used pre-reset).
- **Auth:** Public
- **Body (JSON):** `phone` `string` (1–20) **required**
- **Success:** `200` `{ exists: boolean, phone }`

---

#### `POST /api/v1/auth/password/send-reset`
Send a password-reset OTP (phone via Termii, email via Resend).
- **Auth:** Public
- **Body (JSON):**
  - `phone` `string` (≤20) optional — sends `phone_reset` OTP
  - `email` `string` (email format) optional — sends `email_reset` OTP
- **Success:** `200` `{ via: "phone" }` or `{ via: "email" }`
- **Errors:** `404` no account for the identifier; `422` neither provided / dispatch failure.

---

#### `POST /api/v1/auth/password/reset`
Verify the reset OTP and set a new password.
- **Auth:** Public
- **Body (JSON):**
  - `phone` `string` (≤20) or `email` `string` (email format) — at least one
  - `code` `string` (6) or `otp` `string` (6) — verification code
  - `password` `string` (8–128) or `new_password` `string` (8–128) — new password
- **Success:** `200` `data: null` ("Password reset successfully. You can now log in.")
- **Errors:** `422` missing code / password / identifier, invalid OTP; `404` no account.

---

#### `GET /api/v1/auth/me`
Return the authenticated user.
- **Auth:** JWT (`applyAuthGuard`)
- **Success:** `200` `{ user: { id, name, email, phone, auth_provider, email_verified_at, phone_verified_at, is_suspended, roles, whatsapp_number, location_state, location_sublocation, interests, onboarding_completed, created_at, updated_at } }` (password hash and `provider_id` are stripped).

---

#### `PATCH /api/v1/auth/me`
Update the authenticated user's profile.
- **Auth:** JWT (`applyAuthGuard`)
- **Body (JSON, all optional):**
  - `name` `string` (1–255)
  - `phone` `string` (≤20) — `409` if already used by another account
  - `whatsapp_number` `string` (≤20)
  - `location_state` `string` (≤255)
  - `location_sublocation` `string` (≤255)
  - `interests` `string[]`
  - `onboarding_completed` `boolean`
- **Success:** `200` `{ user }`
- **Errors:** `409` phone taken; `404` user not found.

---

#### `POST /api/v1/auth/logout`
Revoke the current bearer token (in-memory denylist).
- **Auth:** JWT (`applyAuthGuard`)
- **Success:** `200` `data: null` ("Logged out successfully.")

---

### 3.2 KYC — `/api/v1/kyc`

Identity (Tier 1: `nin_front` + `nin_back` + `selfie` + `nin_number`) and Business (Tier 2: Tier 1 + `cac_certificate`) verification. Approved KYC cannot be downgraded (`422`); rejected/pending can be re-submitted. Files upload to Cloudinary; document URLs are stored on the record.

- **Auth:** JWT (`applyAuthGuard`) on both routes.

---

#### `GET /api/v1/kyc/status`
Current user's KYC profile.
- **Auth:** JWT
- **Success:** `200` `{ kyc: <serialized record|null>, tier: 0|1|2, status: "pending"|"approved"|"rejected"|null }` (when no profile: `{ kyc: null, tier: 0, status: null }`).
- **Serialized record fields:** `user_id, tier, status, rejection_reason, documents: [{name,url,kind}], fields, submitted_at, reviewed_at`.

---

#### `POST /api/v1/kyc/submit`
Submit (or re-submit) a KYC application. **multipart/form-data.**
- **Auth:** JWT
- **Body (multipart):**
  - `level` `string`/`number` **required** — `1` or `2` (`t.Numeric()` coerces multipart strings)
  - `nin_number` `string` (≤50)
  - `business_name`, `business_type`, `business_email` `string` (≤255)
  - `business_address` `string` (≤500)
  - `business_phone` `string` (≤20)
  - `rc_number`, `tin_number` `string` (≤100)
  - `nin_front` file, `nin_back` file, `selfie` file (required for Tier 1)
  - `cac_certificate` file (required for Tier 2), `smedan_certificate` file (optional)
  - `documents` repeated file fields (generic extra attachments)
- **Required:** Tier 1 → `nin_front`, `nin_back`, `selfie`, `nin_number`; Tier 2 → all of Tier 1 + `cac_certificate`.
- **Success:** `201` (first submission) or `200` (re-submission) `{ tier, status: "pending" }`.
- **Errors:** `422` invalid level, missing required fields, or downgrade of an approved KYC.

---

### 3.3 Applications — `/api/v1/applications`

Role applications. Seller requires an approved KYC **Tier 2** (`kyc:2`), provider requires **Tier 1** (`kyc:1`) — checked inside the handler against the KYC store.

- **Auth:** JWT (`applyAuthGuard`).

---

#### `GET /api/v1/applications/seller/status`
- **Auth:** JWT
- **Success:** `200` `{ application: <latest seller application|null> }`.

---

#### `POST /api/v1/applications/seller`
Submit a seller application (one pending at a time).
- **Auth:** JWT + approved Tier 2 KYC
- **Body (JSON):**
  - `store_name` `string` (1–255) **required**
  - `store_description` `string` (≤2000) optional
  - `store_phone` `string` (1–20) **required**
  - `store_email` `string` (email format) **required**
  - `store_state` `string` (1–255) **required**
  - `store_sublocation` `string` (1–255) **required**
  - `store_market` `string` (1–255) **required**
  - `store_categories` `string[]` (min 1) **required**
  - `store_address` `string` (≤500) optional
  - `store_lat`, `store_lng` `number` optional
  - `store_logo_url` `string` (≤2000) optional (logo passed as URL; use `/media/upload` first if a binary upload is needed)
- **Success:** `201` `{ application_id, status: "pending" }`
- **Errors:** `403` Tier 2 KYC not approved; `409` pending application already exists (includes `application_id` in `data`).

---

#### `GET /api/v1/applications/provider/status`
- **Auth:** JWT
- **Success:** `200` `{ application: <latest provider application|null> }`.

---

#### `POST /api/v1/applications/provider`
Submit a provider application (one pending at a time).
- **Auth:** JWT + approved Tier 1 KYC
- **Body (JSON):**
  - `full_name` `string` (1–255) **required**
  - `business_name` `string` (≤255) optional
  - `bio` `string` (≤1000) optional
  - `service_categories` `string[]` (min 1) **required**
  - `years_experience` `integer ≥ 0` **required**
  - `price_range` `string` (≤255) optional
  - `response_time` `string` (≤255) optional
  - `availability` one of `immediate | scheduled | busy | weekends | unavailable` **required**
  - `location_state` `string` (1–255) **required**
  - `location_sublocation` `string` (1–255) **required**
  - `location_lat`, `location_lng` `number` optional
  - `contact_phone` `string` (1–20) **required**
  - `contact_whatsapp` `string` (≤20) optional
  - `photo_url` `string` (≤2000) optional
- **Success:** `201` `{ application_id, status: "pending" }`
- **Errors:** `403` Tier 1 KYC not approved; `409` pending application already exists.

---

### 3.4 Catalog — `/api/v1` (mounted in the `/api/v1` group)

Master data. All public. **DB-backed** — without a reachable `DATABASE_URL` these return `500`.

---

#### `GET /api/v1/categories`
Active categories with their subcategory tree.
- **Auth:** Public
- **Success:** `200` `data` = array of `{ id (uuid), name, slug, icon, sort_order, subcategories: [{ id, name, slug, sort_order }] }`, ordered by `sort_order` then `name`.

---

#### `GET /api/v1/locations/states`
Active states with sublocations and markets.
- **Auth:** Public
- **Success:** `200` `data` = array of `{ id (uuid), name, slug, code, sublocations: [{ id, name, slug }], markets: [{ id, name, slug, address }] }`, ordered by name.

---

#### `GET /api/v1/locations/markets`
Filterable markets list.
- **Auth:** Public
- **Query:**
  - `state_id` or `state` `string` — state uuid, slug, partial name, or code (e.g. `LA`)
  - `sublocation` `string` — sublocation uuid, slug, or partial name
  - `q` `string` — market-name substring
  - `limit` `string` — default 100, max capped at 500
- **Success:** `200` `data` = array of `{ id (uuid), name, slug, address, state: {id,name,slug}|null, sublocation: {id,name,slug}|null }`, ordered by name.

---

### 3.5 Search

---

#### `GET /api/v1/search`
Unified search across listings, stores and providers.
- **Auth:** Public
- **Query:**
  - `q` `string`
  - `type` one of `all | listings | stores | providers` (default `all`; unrequested sections return `[]`)
  - `state` `string`
  - `category` `string`
  - `min_price`, `max_price` `string`
  - `condition` `string`
  - `sort` `string` (`newest|price_low|price_high|popular`) — applies to listings only
  - `page`, `per_page` (default 15, max 100)
- **Success:** `200` with a search-specific `meta`:
```jsonc
{
  "success": true,
  "message": "Search results.",
  "data": { "listings": [], "stores": [], "providers": [] },
  "errors": null,
  "meta": { "q": "...", "type": "all", "page": 1, "per_page": 15, "counts": { "listings": 0, "stores": 0, "providers": 0 } }
}
```
Store items are compact `{ id, name, slug, description, logo_path, rating, followers_count }`; provider items `{ id, name, slug, bio, service_categories, rating, completed_jobs }`; listings use the full listing serializer.

---

### 3.6 Listings — `/api/v1`

Route order matters: `GET /listings/deals` is registered **before** `GET /listings/:id`. Listings use UUID public ids; `:id` params are UUIDs (`format: "uuid"`). Soft-deleted rows are hidden everywhere. Distress deals require a **minimum 20% discount** when creating/updating unapproved listings (`422` otherwise).

Auth: `auth` derive from `src/plugins/auth.ts` — the handler returns `401 Unauthenticated.` when no valid Bearer token is supplied on protected routes. Owner-only routes return `403 Unauthorized.` for non-owners.

---

#### `GET /api/v1/listings`
Public feed. Only `status = active` and non-deleted. If a referenced location/category is unresolvable it returns an empty page (not an error).
- **Auth:** Public
- **Query (all optional):**
  - `q` — title/description substring
  - `category`, `category_id`, `category_slug` — category or subcategory (uuid/slug/name resolved via lookup)
  - `subcategory`, `subcategory_id`
  - `state`, `state_id`
  - `sublocation`, `sublocation_id`
  - `market`, `market_id` — mapped to its state/sublocation (listings have no market FK)
  - `min_price`, `max_price` (also `minPrice`, `maxPrice`)
  - `condition`
  - `deal_type` (also `dealType`) one of `distress | deal_of_day | standard`
  - `distress` (also `is_distressed`, `isDistressed`) — `"true"`/`"1"` narrows to distress + deal-of-day
  - `sort` — `newest` (default), `price_low`, `price_high`, `popular` (views)
  - `page`, `per_page` (default 15, max 100)
- **Success:** `200` paginated array of full listings (see `GET /listings/:id` for the shape), `meta` standard.

---

#### `GET /api/v1/listings/deals`
Distress + deal-of-day feed. Registered before `/listings/:id`.
- **Auth:** Public
- **Query:** `deal_type` (`distress` or `deal_of_day` — optional, filters the combined feed), `page`, `per_page`
- **Success:** `200` paginated array of full listings (newest first), standard `meta`.

---

#### `GET /api/v1/listings/:id`
Public listing detail.
- **Auth:** Public
- **Params:** `id` — listing UUID
- **Success:** `200` full listing object:
```jsonc
{
  "id": "<uuid>",
  "user_id": 1,
  "store_id": null,
  "title": "...",
  "slug": "...",
  "description": "...",
  "price": 10000,
  "discount_price": 7500,
  "discount_percentage": 25,
  "is_discounted": true,
  "condition": "new",
  "listing_scope": "personal",
  "deal_type": "distress",
  "status": "active",
  "approved": true,
  "promoted": false,
  "promotion_type": null,
  "promotion_expiry": null,
  "featured": false,
  "views_count": 0,
  "clicks_count": 0,
  "favorites_count": 0,
  "latitude": null,
  "longitude": null,
  "category_specific_fields": null,
  "category": { "id": "<uuid>", "name": "...", "slug": "..." },
  "subcategory": null,
  "state": { "id": "<uuid>", "name": "...", "slug": "..." },
  "sublocation": null,
  "store": null,
  "images": [],
  "created_at": "...",
  "updated_at": "..."
}
```
- **Errors:** `404` "Listing not found."

---

#### `GET /api/v1/user/listings`
Authenticated user's own listings (newest first).
- **Auth:** JWT
- **Query:** `page`, `per_page`
- **Success:** `200` paginated array of full listings, standard `meta`.

---

#### `POST /api/v1/listings`
Create a listing. Starts as `pending` / `approved: false` until a staff member approves it. Distress deals require ≥20% discount. A `promotion_package`/`promotion_type` immediately marks the listing promoted.
- **Auth:** JWT
- **Body (JSON):**
  - `title` `string` (1–255) **required**
  - `description` `string` (min 1) **required**
  - `price` `number ≥ 0` **required**
  - `discount_price` `number ≥ 0` or `null` optional
  - `category_id` or `category` `string` **required** (must resolve)
  - `subcategory_id` `string` optional
  - `state_id` or `state` `string` **required** (must resolve)
  - `sublocation_id` or `sublocation` `string` optional
  - `store_id` `string`(uuid) or `null` optional — must be a store you own (a non-uuid or foreign store → `422`)
  - `condition` `string` (min 1) **required**
  - `listing_scope` `string` — `"store"` (requires your `store_id`) or `"personal"` (default)
  - `deal_type` (also `dealType`) `string` — `standard` (default), `distress`, `deal_of_day`
  - `latitude`, `longitude` `number` or `null`
  - `category_specific_fields` object
  - `promotion_package` / `promotion_type` `string` — one of `bump_5_days`, `top_featured_7_days`, `top_15_days`, `top_featured_20_days`
- **Success:** `201` full listing (message "Listing created.")
- **Errors:** `401`; `422` bad category/state/subcategory/sublocation/store, distress discount < 20%, store-listing without store_id; `500` insert failure.

---

#### `PUT /api/v1/listings/:id`
Update your own listing. Optional patch body (all fields optional; `category_id`/`state_id` etc. resolve like create). Price/discount recompute discount metadata. Distress constraint enforced for unapproved listings.
- **Auth:** JWT (owner)
- **Params:** `id` — listing UUID
- **Body (JSON, all optional):** `title`, `description`, `price`, `discount_price` (number or `null`), `category_id`/`category`, `subcategory_id` (string or `null`), `state_id`/`state`, `sublocation_id`/`sublocation` (string or `null`), `condition`, `deal_type`/`dealType`, `latitude`/`longitude` (number or `null`), `category_specific_fields`, `promotion_package`/`promotion_type`
- **Success:** `200` full listing
- **Errors:** `403` not the owner; `404`; `422` unknown references / distress discount.

---

#### `DELETE /api/v1/listings/:id`
Soft-delete your own listing (decrements the owning store's `listings_count`).
- **Auth:** JWT (owner)
- **Params:** `id` — listing UUID
- **Success:** `200` `data: null` ("Listing deleted successfully.")
- **Errors:** `403`, `404`.

---

#### `POST /api/v1/listings/:id/images`
Upload listing images. **multipart/form-data.** First image becomes `is_primary`.
- **Auth:** JWT (owner)
- **Params:** `id` — listing UUID
- **Body (multipart):** `images` — 1–5 files (repeated field allowed)
- **Success:** `201` array of `{ id (int), path, url, is_primary }`
- **Errors:** `403`, `404`, `422` (no images / more than 5).

---

#### `POST /api/v1/listings/:id/promote`
Apply a paid promotion package to your listing.
- **Auth:** JWT (owner)
- **Params:** `id` — listing UUID
- **Body (JSON):** `tier` or `promotion_package` `string` — one of `bump_5_days` (5d, not featured), `top_featured_7_days` (7d, featured), `top_15_days` (15d), `top_featured_20_days` (20d, featured)
- **Success:** `200` full listing (message "Listing promoted.")
- **Errors:** `403`, `404`, `422` unknown tier.

---

#### `POST /api/v1/listings/:id/click`
Record a click (public analytics counter).
- **Auth:** Public
- **Params:** `id` — listing UUID
- **Success:** `200` `{ clicks_count }` ("Click recorded.")
- **Errors:** `404`.

---

#### `POST /api/v1/listings/:id/view`
Record a view (public analytics counter).
- **Auth:** Public
- **Params:** `id` — listing UUID
- **Success:** `200` `{ views_count }` ("View recorded.")
- **Errors:** `404`.

---

#### `POST /api/v1/listings/:id/favorite`
Toggle favorite for the authenticated user (add/remove).
- **Auth:** JWT
- **Params:** `id` — listing UUID
- **Success:** `200` `{ is_favorited: true|false, favorites_count }`
- **Errors:** `401`, `404`.

---

#### `GET /api/v1/user/favorites`
Authenticated user's favorited (active) listings, newest favorite first.
- **Auth:** JWT
- **Query:** `page`, `per_page`
- **Success:** `200` paginated array of full listings, standard `meta`.

---

#### `POST /api/v1/listings/:id/recently-viewed`
Track a listing view for the authenticated user. Keeps only the 20 most recent rows per user.
- **Auth:** JWT
- **Params:** `id` — listing UUID
- **Success:** `200` `data: null` ("Listing added to recently viewed.")
- **Errors:** `401`, `404`.

---

#### `GET /api/v1/user/recently-viewed`
Authenticated user's recently-viewed active listings (most recent first, max 20, ordered by view recency).
- **Auth:** JWT
- **Success:** `200` array (non-paginated) of full listings.

---

### 3.7 Stores — `/api/v1`

`GET /stores` and `GET /stores/:id` are public; the rest require a JWT (`auth` derive, `401` when absent). Owner routes return `403`.

---

#### `GET /api/v1/stores`
Public verified-store directory. Only `status = active` and `is_verified = true`. Ordered by `last_active_at` (desc). Unresolvable location filters return an empty page.
- **Auth:** Public
- **Query:** `q` (name/description), `state`, `sublocation`, `market`, `category` (JSONB-contains on `categories`), `page`, `per_page`
- **Success:** `200` paginated store objects:
```jsonc
{
  "id": "<uuid>",
  "user": { "id": 1, "name": "..." },
  "name": "...", "slug": "...", "description": null,
  "logo_path": null, "banner_path": null,
  "phone": null, "email": null, "whatsapp_number": null, "address": null,
  "categories": null, "social_links": null, "opening_hours": null,
  "is_verified": true, "status": "active",
  "rating": 0, "review_count": 0, "listings_count": 0, "followers_count": 0,
  "state": null, "sublocation": null, "market": null,
  "created_at": "...", "updated_at": "..."
}
```

---

#### `GET /api/v1/stores/:id`
Public storefront (bumps `last_active_at`).
- **Auth:** Public
- **Params:** `id` — store UUID
- **Success:** `200` store object
- **Errors:** `404` "Store not found."

---

#### `POST /api/v1/stores`
Create your store (one per user — `422` if you already have one).
- **Auth:** JWT
- **Body (JSON):**
  - `name` `string` (1–255) **required**
  - `description` `string` (≤2000) optional
  - `phone` `string` (≤20), `email` `string` (≤255), `whatsapp_number` `string` (≤20) optional
  - `state_id`, `sublocation_id`, `market_id` `string` optional (must resolve if provided)
  - `address` `string` (≤500) optional
  - `categories` `string[]` optional
  - `social_links`, `opening_hours` `Record<string,string>` optional
- **Success:** `201` store object ("Store created successfully.")
- **Errors:** `401`, `422` (already have a store / unknown location).

---

#### `PUT /api/v1/stores/:id`
Update your own store. Optional patch body — all create fields plus `null` values to clear.
- **Auth:** JWT (owner)
- **Params:** `id` — store UUID
- **Success:** `200` store object
- **Errors:** `403`, `404`, `422`.

---

#### `GET /api/v1/user/store`
Your own store.
- **Auth:** JWT
- **Success:** `200` store object, or `data: null` if you have none.

---

#### `POST /api/v1/stores/:id/follow`
Follow a store.
- **Auth:** JWT
- **Params:** `id` — store UUID
- **Success:** `201` `{ followers_count }` ("Store followed.") — or `200` `{ followers_count }` when already following.

---

#### `DELETE /api/v1/stores/:id/follow`
Unfollow a store.
- **Auth:** JWT
- **Params:** `id` — store UUID
- **Success:** `200` `{ followers_count }`
- **Errors:** `404` store or not-following.

---

#### `GET /api/v1/stores/counts`
Nationwide count and breakdown by state/sublocation/market.
- **Auth:** Public
- **Query:** `state` (optional), `sublocation` (optional)
- **Success:** `200` `{ total, states: [{ state_id, state_name, state_slug, count }], sublocations?: [...], markets?: [...] }`

---

#### `GET /api/v1/user/stores`
List all stores owned by the authenticated user.
- **Auth:** JWT
- **Success:** `200` array of store objects with `views_count`, `followers_count`, `is_promoted`.

---

#### `POST /api/v1/stores/:id/view`
Record a view for a storefront with 5-minute deduplication window per user/IP. Increments store `views_count` and notifies store owner.
- **Auth:** Optional JWT
- **Params:** `id` — store UUID
- **Success:** `200` `{ views_count, throttled: boolean }`

---

#### `GET /api/v1/user/stores/:id/analytics`
Detailed view and follower analytics for the store owner.
- **Auth:** JWT (store owner or admin)
- **Params:** `id` — store UUID
- **Query:** `page`, `per_page`
- **Success:** `200` `{ store: { id, name, views_count, followers_count }, recent_viewers: [{ id, viewer, viewed_at }], meta }`

---

#### `POST /api/v1/stores/:id/promote`
Activate a store promotion package.
- **Auth:** JWT (store owner or admin)
- **Params:** `id` — store UUID
- **Body:** `{ promotion_package: "store_3_days" | "store_5_days" | "store_1_week" | "store_1_month", payment_reference?: string }`
- **Success:** `200` serialized store object with `is_promoted: true`, `promotion_type`, `promotion_expiry`.

---

#### `GET /api/v1/stores/:id/followers`
List followers of a specific store.
- **Auth:** Public
- **Params:** `id` — store UUID
- **Query:** `page`, `per_page`
- **Success:** `200` paginated list of users following the store.

---

#### `POST /api/v1/stores/:id/unfollow`
Unfollow a store via POST (alias for `DELETE /stores/:id/follow`).
- **Auth:** JWT
- **Params:** `id` — store UUID
- **Success:** `200` `{ followers_count }`

---

#### `GET /api/v1/user/followed-stores`
List stores the authenticated user follows (alias for `GET /user/following`).
- **Auth:** JWT
- **Query:** `page`, `per_page`
- **Success:** `200` paginated store objects + `followed_at`.

---

### 3.7.1 View Tracking — `/api/v1`

#### `POST /api/v1/users/:id/view`
Record a user profile view with 5-minute deduplication throttle. Increments user `profile_views_count` and sends in-app notice to profile owner.
- **Auth:** Optional JWT
- **Params:** `id` — target user ID
- **Success:** `200` `{ profile_views_count, throttled: boolean }`

---

#### `GET /api/v1/user/profile/analytics`
Profile view analytics for the authenticated user.
- **Auth:** JWT
- **Query:** `page`, `per_page`
- **Success:** `200` `{ profile_views_count, recent_viewers: [{ id, viewer, viewed_at }], meta }`

---

#### `POST /api/v1/providers/:id/view`
Record a service provider profile view with 5-minute deduplication throttle. Supports provider UUID, numeric ID, or slug. Increments provider `views_count` and dispatches in-app notice (`service_viewed`) with direct chat link and profile URL to the provider owner.
- **Auth:** Optional JWT
- **Params:** `id` — provider UUID, numeric ID, or slug
- **Success:** `200` `{ views_count, throttled: boolean }`

---

#### `GET /api/v1/user/providers/:id/analytics`
Service provider view analytics for the provider owner or staff administrator.
- **Auth:** JWT (Owner or Admin)
- **Params:** `id` — provider UUID, numeric ID, or slug
- **Query:** `page`, `per_page`
- **Success:** `200` `{ provider: { id, uuid, name, views_count }, recent_viewers: [{ id, viewer, viewed_at }], meta }`
- **Errors:** `403` unauthorized access.

---

### 3.7.2 Item Requests ("Request an Item") — `/api/v1`

#### `GET /api/v1/item-requests/browse`
Browse open buyer item requests for sellers seeking leads.
- **Auth:** Public
- **Query:** `category`, `subcategory`, `state`, `sublocation`, `min_budget`, `max_budget`, `status` (default `open`), `page`, `per_page`
- **Success:** `200` paginated item requests with `responses_count`, `broadcast_count`, creator user summary.

---

#### `POST /api/v1/item-requests`
Post a want-ad. Triggers automated two-pool scoring notification engine to candidate sellers (up to 15 promoted + 15 organic stores matching location & category).
- **Auth:** JWT
- **Body:** `{ title: string, description: string, category_id?: string|number, subcategory_id?: string|number, state_id?: string|number, sublocation_id?: string|number, budget_min?: number, budget_max?: number, images?: string[] }`
- **Success:** `201` created item request object with `uuid`, `status: "open"`.

---

#### `GET /api/v1/item-requests/my`
List all item requests posted by the authenticated buyer.
- **Auth:** JWT
- **Query:** `status`, `page`, `per_page`
- **Success:** `200` paginated user requests with response counts.

---

#### `GET /api/v1/item-requests/offers`
List all responses/offers received across all item requests owned by the authenticated buyer.
- **Auth:** JWT
- **Query:** `page`, `per_page`
- **Success:** `200` paginated offers with seller store profile and linked listing details.

---

#### `GET /api/v1/item-requests/:id`
View single item request by UUID or ID with its seller offers.
- **Auth:** Public (offers only visible to owner or response creator)
- **Params:** `id` — request UUID or ID
- **Success:** `200` item request detail with `responses` array.

---

#### `PATCH /api/v1/item-requests/:id/status`
Update status of an item request.
- **Auth:** JWT (request creator or admin)
- **Params:** `id` — request UUID or ID
- **Body:** `{ status: "open" | "fulfilled" | "cancelled" | "expired" }`
- **Success:** `200` updated request object.

---

#### `POST /api/v1/item-requests/:id/responses`
Seller submits an offer response on a buyer's item request. Notifies the buyer.
- **Auth:** JWT (store owner)
- **Params:** `id` — request UUID or ID
- **Body:** `{ price: number, message: string, listing_id?: string|number, images?: string[] }`
- **Success:** `201` created offer response with seller store details.

---

### 3.8 Providers — `/api/v1`

`GET /providers/bookings` is registered **before** `GET /providers/:id`. Public directory routes read `is_verified = true` only.

---

#### `GET /api/v1/providers`
Public verified-provider directory. Ordered by `rating` desc, then `completed_jobs` desc.
- **Auth:** Public
- **Query:** `q` (name/bio), `category`, `state`, `sublocation`, `availability` (only `immediate|scheduled`; anything else returns an empty page), `page`, `per_page`
- **Success:** `200` paginated provider objects:
```jsonc
{
  "id": "<uuid>", "name": "...", "slug": "...", "bio": null,
  "photo_path": null, "service_categories": [], "experience_years": 0,
  "price_range": null, "response_time": null, "availability": "...",
  "phone": null, "whatsapp": null, "location_text": null, "skills": null,
  "is_verified": true, "rating": 0, "total_reviews": 0, "completed_jobs": 0,
  "state": null, "sublocation": null, "created_at": "...", "updated_at": "..."
}
```

---

#### `GET /api/v1/providers/bookings`
Incoming bookings for the authenticated user's provider profile.
- **Auth:** JWT (must own a provider profile → else `403`)
- **Query:** `status`, `page`, `per_page`
- **Success:** `200` paginated raw booking rows (newest first).

---

#### `GET /api/v1/providers/:id`
Public provider profile.
- **Auth:** Public
- **Params:** `id` — provider UUID
- **Success:** `200` provider object
- **Errors:** `404`.

---

#### `PUT /api/v1/providers/:id`
Update your own provider profile.
- **Auth:** JWT (owner)
- **Params:** `id` — provider UUID
- **Body (JSON, all optional):** `bio` (≤2000 or null), `service_categories` `string[]`, `experience_years` `integer ≥ 0`, `price_range` (≤100 or null), `response_time` (≤100 or null), `availability` (`immediate|scheduled` — anything else → `422`), `phone`/`whatsapp` (≤20 or null), `location_text` (≤255 or null), `skills` (`string[]` or null)
- **Success:** `200` provider object
- **Errors:** `403`, `404`, `422`.

---

#### `POST /api/v1/providers/:id/bookings`
Buyer creates a booking request for a provider (status `pending`).
- **Auth:** JWT
- **Params:** `id` — provider UUID
- **Body (JSON):**
  - `service_type` `string` (1–255) **required**
  - `description` `string` (≤2000) optional
  - `preferred_date` `string` optional (must parse as a date else `422`)
  - `preferred_time` `string` (≤50) optional
  - `location_text` `string` (≤500) optional
  - `latitude` `number` (-90–90), `longitude` `number` (-180–180) optional
- **Success:** `201` booking row ("Booking request submitted successfully.")
- **Errors:** `401`, `404`, `422`.

---

#### `POST /api/v1/providers/:id/contact-updates`
Provider owner proposes contact changes for staff approval (reviewed in `/api/v1/admin/contact-updates`).
- **Auth:** JWT (owner)
- **Params:** `id` — provider UUID
- **Body (JSON):** `proposed_changes` `Record<string, unknown>` — allowed keys: `phone`, `whatsapp`, `email`, `location_text`, `bio`
- **Success:** `201` contact-update row ("Contact update submitted for review.")
- **Errors:** `403`, `404`, `422` (empty changes / unknown fields).

---

### 3.9 Bookings — `/api/v1`

Buyer-facing booking list/detail plus shared status transitions. Provider-side listing lives under `GET /providers/bookings`. `:id` params are booking UUIDs.

Status transitions: `pending → accepted|declined` (provider owner only) · `accepted → completed` (provider owner only) · any non-final → `cancelled` (buyer or provider owner).

---

#### `GET /api/v1/bookings`
Authenticated user's bookings (as buyer).
- **Auth:** JWT
- **Query:** `status`, `page`, `per_page`
- **Success:** `200` paginated booking objects (newest first):
```jsonc
{
  "id": "<uuid>", "service_type": "...", "description": null,
  "preferred_date": null, "preferred_time": null, "location_text": null,
  "quoted_price": null, "final_price": null, "status": "pending",
  "cancellation_reason": null, "accepted_at": null, "started_at": null,
  "completed_at": null, "cancelled_at": null,
  "provider": { "uuid": "...", "name": "...", "slug": "...", "photo_path": null },
  "user": { "id": 1, "name": "..." },
  "created_at": "...", "updated_at": "..."
}
```

---

#### `GET /api/v1/bookings/:id`
Booking detail — buyer or the provider owner only.
- **Auth:** JWT
- **Params:** `id` — booking UUID
- **Success:** `200` booking object
- **Errors:** `403` (neither party), `404`.

---

#### `PATCH /api/v1/bookings/:id/status`
Transition a booking's status. Once `completed`, `cancelled` or `declined` (final), further changes are rejected `422`.
- **Auth:** JWT (buyer or provider owner — actor restrictions below)
- **Params:** `id` — booking UUID
- **Body (JSON):**
  - `status` one of `accepted | declined | completed | cancelled` **required**
  - `reason` `string` (≤1000) optional — used for `declined`/`cancelled`
  - `quoted_price` `number ≥ 0` optional — sets `quoted_price` on accept, `final_price` on complete
- **Success:** `200` updated booking row ("Booking accepted." / "Booking declined." / "Booking completed." / "Booking cancelled.")
- **Errors:** `401`, `403` (wrong actor vs transition), `404`, `422` (finalized / wrong source status / bad status value).

---

### 3.10 Reviews — `/api/v1`

Polymorphic ratings and reviews. Accepts parameter aliases (`reviewable_type` / `target_type` / `type`, and `reviewable_id` / `target_id` / `id`). Supports stores, service providers, listings, and seller/user profiles by UUID, numeric ID, or slug. Automatically recomputes aggregate ratings on stores and service providers, and sends in-app notice (`review_received`) to the owner.

---

#### `GET /api/v1/reviews`
List reviews for a target, newest first. Public. Includes an average/total summary in `meta`.
- **Auth:** Public
- **Query (required):**
  - `target_type` (or `reviewable_type` / `type`) — `store | provider | listing | seller | user`
  - `target_id` (or `reviewable_id` / `id`) — UUID, numeric ID, or slug
  - `page`, `per_page`
- **Success:** `200` paginated reviews + `meta.average_rating`:
```jsonc
{
  "success": true,
  "message": "OK",
  "data": [ { "id": "<uuid>", "target_type": "store", "target_id": "<uuid>", "rating": 4, "comment": "...", "reply": null, "user": { "id": 1, "name": "..." }, "created_at": "..." } ],
  "errors": null,
  "meta": { "current_page": 1, "per_page": 15, "total": 1, "last_page": 1, "average_rating": 4 }
}
```
- **Errors:** `422` missing/invalid `target_type`/`target_id`; `404` target not found.

---

#### `POST /api/v1/reviews`
Submit a review (one per user per target → `409` duplicate). Store/provider rating aggregates are recomputed on insert, and owner is notified.
- **Auth:** JWT
- **Body (JSON):**
  - `target_type` (or `reviewable_type` / `type`) `string` — `store | provider | listing | seller | user` **required**
  - `target_id` (or `reviewable_id` / `id`) `string` — UUID, numeric ID, or slug **required**
  - `booking_id` `string | number` optional
  - `rating` `integer` 1–5 **required**
  - `comment` `string` (≤2000) optional
- **Success:** `201` review row ("Review submitted successfully.")
- **Errors:** `401`, `404` target not found, `409` duplicate, `422` bad type/rating.

---

### 3.11 Saved searches — `/api/v1`

User-scoped saved listing-search filters. **Note:** `:id` is the **numeric** integer PK (saved_searches rows have no uuid column).

---

#### `GET /api/v1/user/saved-searches`
- **Auth:** JWT
- **Success:** `200` array of `{ id (int), name, filters, createdAt }`, newest first.

---

#### `POST /api/v1/user/saved-searches`
- **Auth:** JWT
- **Body (JSON):**
  - `name` `string` (1–120) **required** (blank → `422`)
  - `filters` `object` **required**
- **Success:** `201` created row ("Saved search created.")

---

#### `DELETE /api/v1/user/saved-searches/:id`
- **Auth:** JWT
- **Params:** `id` — numeric id
- **Success:** `200` `data: null`
- **Errors:** `404` missing or not yours (also `404` for non-numeric ids).

---

### 3.12 Adverts — `/api/v1/adverts`

In-memory store. `GET /adverts/active` needs no DB. Auth is the **header stub** (`x-user-id` **defaults to `1`**, `x-user-role`/`x-user-name` optional).

---

#### `GET /api/v1/adverts/active`
Public showcase — live (published) adverts, newest first. **Works without a database.**
- **Auth:** Public
- **Query:** `page`, `per_page` (default 20, cap 100)
- **Success:** `200` array of adverts + `meta` `{ page, per_page, total, total_pages }`.
- Advert shape: `{ id, uuid, userId, title, description, image_url, link, starts_at, ends_at, status: "active", created_at }`.

---

#### `POST /api/v1/adverts`
Submit an advert for staff review (status `pending`). Publishing is a staff action (`/api/v1/admin/adverts/:id/publish`).
- **Auth:** x-user-ID stub (defaults to `1`)
- **Body (JSON):**
  - `title` `string` **required** (≤255)
  - `description` `string` or `null` (≤2000) optional
  - `image_url` `string` or `null` optional (must be a valid http(s) URL)
  - `link` `string` or `null` optional (must be a valid http(s) URL)
  - `starts_at` `string` or `null` optional (valid date)
  - `ends_at` `string` or `null` optional (valid date, after `starts_at`)
- **Success:** `201` advert row ("Advert submitted for review.")
- **Errors:** `422` with `errors` array (field-level messages).

---

### 3.13 Chat — `/api/v1/chat`

Chat archive/presence. **Firebase RTDB stays the realtime layer** — the client double-writes here; `conversation_id` is the client's own Firebase key (a string, **NOT a UUID**) and is never the access check. Authorization is row-level participation (sender/receiver match), widened for staff (`x-user-role: admin`/`verifier` sees everything). Auth is the **header stub** (`x-user-id` defaults to `1`).

---

#### `POST /api/v1/chat/sync`
Bulk-archive messages. Idempotent per `(conversation_id, sender_id, client_message_id)`. All-or-nothing validation.
- **Auth:** x-user-ID stub
- **Body (JSON):**
  - `messages` array (1–100) of:
    - `conversation_id` `string` (≤191) **required**
    - `client_message_id` `string` (≤128) **required**
    - `receiver_id` `number` **required** (positive integer, ≠ sender)
    - `message` `string` (≤5000) or `null` — required unless `attachment_url` present
    - `message_type` `string` — `text` (default) | `image` | `file`
    - `attachment_url` `string` or `null`
- **Success:** `200` (all duplicates) or `201` (≥1 created): message rows + `meta` `{ created, duplicates }`.
- **Errors:** `422` with `errors` array of `{ index, error }` (nothing inserted).

---

#### `POST /api/v1/chat/presence`
Update your presence heartbeat.
- **Auth:** x-user-ID stub
- **Body (JSON):** `is_online` `boolean` **required**, `last_seen` `string` optional (defaults to now)
- **Success:** `200` `{ id, is_online, last_seen }`.

---

#### `GET /api/v1/chat/conversations`
Inbox — every conversation you participate in, newest activity first, each with latest message, unread count, and counterpart presence.
- **Auth:** x-user-ID stub
- **Success:** `200` array of `{ conversation_id, participant: { id, is_online, last_seen }, last_message, unread_count, updated_at }`.

---

#### `GET /api/v1/chat/:conversationId`
Thread history (newest first).
- **Auth:** x-user-ID stub
- **Params:** `conversationId` — the client's Firebase key (string)
- **Query:** `limit` (default 30, capped 1–100), `before` (numeric message id cursor)
- **Success:** `200` message rows + `meta` `{ conversation_id, unread_count, has_more }`.

---

#### `POST /api/v1/chat/:conversationId/read`
Mark your incoming messages in the thread as read.
- **Auth:** x-user-ID stub
- **Params:** `conversationId` — the client's Firebase key
- **Success:** `200` `{ marked, unread_count: 0 }`.

---

### 3.14 Notifications — `/api/v1/notifications`

In-app notification centre + Expo push-token registry + user notification preferences. Account-wide `unread_count` is reported in `meta` regardless of page. Protected by real JWT guard (`applyAuthGuard`).

---

#### `GET /api/v1/notifications`
Paginated feed (newest first).
- **Auth:** JWT
- **Query:** `page`, `per_page` (default 20, cap 100), `unread` (`"true"`/`"1"` filters to unread), `type`
- **Success:** `200` notification rows + `meta` `{ page, per_page, total, total_pages, unread_count }`.
- Row shape: `{ id, userId, type, title, body, data, read_at, created_at }`.

---

#### `GET /api/v1/notifications/settings`
Get user notification preferences. Returns defaults merged with saved preferences, providing both `snake_case` and `camelCase` keys for mobile compatibility.
- **Auth:** JWT
- **Success:** `200` `{ settings: { push_enabled, pushEnabled, email_enabled, emailEnabled, sms_enabled, smsEnabled, ... } }`.

---

#### `PUT /api/v1/notifications/settings`
#### `PATCH /api/v1/notifications/settings`
Update user notification preferences. Accepts `{ settings: { ... } }` or flat settings object.
- **Auth:** JWT
- **Body (JSON):** Dictionary of boolean preferences (`push_enabled`, `email_hot_deals`, `push_new_messages`, `view_notifications_push`, etc.)
- **Success:** `200` `{ message: "Notification preferences updated.", settings: { ... } }`.

---

#### `POST /api/v1/notifications/push-token`
Register an Expo push token (a token moved to another account is reassigned).
- **Auth:** x-user-ID stub
- **Body (JSON):**
  - `token` or `device_token` `string` **required** (at least one)
  - `platform` `string` **required**
  - `device_name` `string` or `null` optional
- **Success:** `200` registered token row
- **Errors:** `422` invalid token (field messages in `errors`).

---

#### `DELETE /api/v1/notifications/push-token`
Remove a push token (e.g. on logout).
- **Auth:** x-user-ID stub
- **Body (JSON, optional):** `token` or `device_token` `string`
- **Query (optional):** `token` or `device_token` `string`
- **Success:** `200` `{ removed: boolean }`.

---

#### `POST /api/v1/notifications/read-all`
Mark every notification read (registered before `/:id/read`).
- **Auth:** x-user-ID stub
- **Success:** `200` `{ marked, unread_count: 0 }`.

---

#### `POST /api/v1/notifications/:id/read`
Mark one notification read (scoped to the caller — someone else's notification reads as `404`).
- **Auth:** x-user-ID stub
- **Params:** `id` — numeric notification id
- **Success:** `200` row + `meta` `{ unread_count }`
- **Errors:** `404` (not found / not yours / non-numeric).

---

### 3.15 Support — `/api/v1/support`

Support ticketing. Every ticket lookup is scoped to the caller — staff (via `x-user-role` containing `admin` or `verifier`) see everything, users only their own; misses return `404` (not `403`) so ids aren't enumerable. The opening message becomes the first thread entry. Auth is the **header stub** (`x-user-id` defaults to `1`).

---

#### `GET /api/v1/support/tickets`
Inbox — newest activity first. Staff see all tickets.
- **Auth:** x-user-ID stub
- **Query:** `page`, `per_page` (default 20), `status`, `category`
- **Success:** `200` tickets + `meta` `{ page, per_page, total, total_pages }`.
- Ticket shape: `{ id, ticketNumber, userId, subject, category, priority, status, platform, last_message, last_message_at, assignee_id, resolved_at, closed_at, created_at }`.

---

#### `POST /api/v1/support/tickets`
Open a ticket.
- **Auth:** x-user-ID stub
- **Body (JSON):**
  - `subject` `string` **required** (≤255)
  - `message` `string` **required** (≤5000)
  - `category` `string` one of `general_inquiry | report_issue | account_services | listing_issues | verification_issues | billing | other` (default `general_inquiry`)
  - `priority` `string` one of `low | normal | high | urgent` (default `normal`)
  - `platform` `string` optional
- **Success:** `201` ticket (ticket number format `DN-SUP-XXXX`)
- **Errors:** `422` with field-level `errors`.

---

#### `GET /api/v1/support/tickets/:id`
Full thread. Marks the counterparty's messages read (badge driver).
- **Auth:** x-user-ID stub
- **Params:** `id` — numeric ticket id
- **Success:** `200` `{ ticket, messages: [...] }`
- **Errors:** `404`.

---

#### `POST /api/v1/support/tickets/:id/reply`
Append a message. A user replying to a `resolved` ticket reopens it (`open`); a staff reply to an `open` ticket moves it to `pending`. Closed tickets reject replies (`422`).
- **Auth:** x-user-ID stub
- **Params:** `id` — numeric ticket id
- **Body (JSON):** `message` `string` (≤5000) **required**
- **Success:** `201` reply row + `meta` `{ ticket_status }`
- **Errors:** `404`, `422`.

---

#### `PATCH /api/v1/support/tickets/:id/status`
Set ticket status. Owners may only set `resolved` or `closed`; staff may set any of `open | pending | resolved | closed`.
- **Auth:** x-user-ID stub
- **Params:** `id` — numeric ticket id
- **Body (JSON):** `status` `string` **required** (`open|pending|resolved|closed`)
- **Success:** `200` ticket ("Ticket DN-SUP-XXXX is now ….")
- **Errors:** `404`, `422` (invalid status / owner tried a status they cannot set).

---

### 3.16 Referrals — `/api/v1/referrals`

Referral attribution (invite links / install tracking). Lifecycle `pending → registered → converted`. Auth is the **header stub**, optional: `POST /referrals/register` is anonymous-friendly (invite link opened pre-signup); `attribution` falls back to user id `1`.

---

#### `POST /api/v1/referrals/register`
Register a referral (or campaign) against the caller.
- **Auth:** x-user-ID stub (optional; `user_id` in body also accepted)
- **Body (JSON):**
  - `code` `string` (≤60) or `campaign` `string` (≤60) — at least one required
  - `user_id` `number` or `null` optional (used when the header is absent)
  - `metadata` `object` optional
- **Success:** `201` attribution row (`status` is `registered` when a user is attached, else `pending`)
- **Errors:** `422` neither `code` nor `campaign` / code too long.

---

#### `POST /api/v1/referrals/attribution`
Track a conversion event. Passing `attribution_id` converts an existing attribution; otherwise a new conversion row is created and `source` is required.
- **Auth:** x-user-ID stub (optional)
- **Body (JSON):**
  - `source` `string` (≤120) optional (required when no `attribution_id`)
  - `campaign` `string` (≤60) optional
  - `event` `string` (≤60) optional
  - `attribution_id` `string` optional (the attribution's uuid or id)
  - `metadata` `object` optional
- **Success:** `200` attribution row (`status: "converted"`)
- **Errors:** `404` attribution not found; `422` missing `source`.

---

### 3.17 Safety — `/api/v1/reports`

---

#### `POST /api/v1/reports/safety`
Submit a safety report (scam, fake listing, harassment, unsafe meeting, spam, other) for staff review.
- **Auth:** x-user-ID stub (defaults to `1`)
- **Body (JSON):**
  - `target_type` `string` **required** — `listing | user | store | message | other`
  - `target_id` `string`/`number` or `null` optional
  - `reason` `string` **required** — `scam | fake_listing | harassment | unsafe_meeting | spam | other`
  - `details` `string` **required** (≤2000)
- **Success:** `201` report row (`status: "pending"`)
- **Errors:** `422` with field-level `errors`.

---

### 3.18 Payments — `/api/v1/payments`

Paystack integration. `initialize`/`verify` use the **header stub** (`x-user-id` required; `x-user-email` optional, defaults to `<id>@example.com`). The webhook is public but HMAC-verified. In-memory transaction store.

---

#### `POST /api/v1/payments/initialize`
Create a transaction (status `pending`) and get a Paystack authorization URL.
- **Auth:** x-user-ID stub
- **Body (JSON):**
  - `amount` `number ≥ 100` (naira) **required** — ₦100 minimum (Laravel validator parity)
  - `booking_id` `string` (≤64) optional
  - `metadata` `object` optional (merged with `user_id` + `transaction_id`)
  - `callback_url` `string` (≤2048) optional
- **Success:** `201` `{ authorization_url, access_code, reference, transaction }` where `transaction` = `{ reference, amount, amount_kobo, status: "pending", channel, gateway_response, paid_at, metadata }`
- **Errors:** `401`; `502` gateway init failure (transaction marked `failed`).

---

#### `POST /api/v1/payments/verify`
Verify a transaction against Paystack by reference. Already-processed transactions return immediately.
- **Auth:** x-user-ID stub
- **Body (JSON):** `reference` `string` (1–128) **required**
- **Success:** `200` `{ transaction }` (status `success` → "Payment successful.", else "Payment failed/reversed.")
- **Errors:** `401`; `404` unknown reference; `502` verification failure.

---

#### `POST /api/v1/payments/webhook`
Paystack `charge.success` webhook. **Raw text body** required — the HMAC-SHA512 covers the exact bytes (`x-paystack-signature` header).
- **Auth:** Public (HMAC-verified)
- **Headers:** `x-paystack-signature`
- **Body:** raw text JSON of the Paystack event
- **Behaviour:** on `event: "charge.success"` with a known pending `reference`, marks the transaction `success` with channel/gateway response/authorization/paid_at.
- **Success:** `200` `data: null` ("Webhook processed.")
- **Errors:** `401` invalid signature; `422` unparseable payload.

---

### 3.19 Media — `/api/v1/media`

Single upload endpoint shared by the KYC and listing flows. Uses the **header stub**: `x-user-id` required (no role check).

---

#### `POST /api/v1/media/upload`
Upload a file to Cloudinary. **multipart/form-data.**
- **Auth:** x-user-ID stub
- **Body (multipart):**
  - `file` file **required** (non-empty)
  - `folder` `string` (≤128) optional — letters/digits/slash/dash/underscore only, no `..`; default `uploads/<user-id>`
- **Success:** `201` `{ url, public_id, path }`
- **Errors:** `401`; `422` invalid folder or empty file.

---

### 3.20 Admin — `/api/v1/admin`

Staff review queues, user management, markets, and broadcasts. In-memory `AdminStore` (reset/seed by tests). All routes use the **header stub** auth:

- Required headers: `x-user-id` (401 when missing), `x-user-role` (single role or comma-separated list).
- **Staff** (`admin|verifier`) can access the review queues below.
- **Admin-only** routes (where marked) require role `admin`; others get `403 "Forbidden. Staff access required."`.

---

#### `GET /api/v1/admin/dashboard/stats`
- **Auth:** staff (`admin|verifier`)
- **Success:** `200` `{ total_users, total_listings, active_listings, pending_listings, total_stores, total_providers, total_transactions, revenue_total }`.

---

#### `GET /api/v1/admin/kyc`
KYC review queue.
- **Auth:** staff
- **Query:** `status` (`pending|approved|rejected`), `tier` (`1|2`), `page`, `per_page` (default 20, max 100)
- **Success:** `200` paginated KYC items (newest first; standard `meta`). Item: `{ id, userId, tier, status, rejectionReason, reviewedBy, reviewedAt, createdAt }`.

---

#### `POST /api/v1/admin/kyc/:id/approve`
- **Auth:** staff
- **Success:** `200` `{ id, tier, status: "approved" }`
- **Errors:** `404`.

#### `POST /api/v1/admin/kyc/:id/reject`
- **Auth:** staff
- **Body:** `reason` `string` (1–500) **required**
- **Success:** `200` `{ id, reason }`
- **Errors:** `404`.

---

#### `GET /api/v1/admin/applications/sellers`
- **Auth:** staff
- **Query:** `page`, `per_page` (default 20)
- **Success:** `200` paginated seller applications (newest first).

#### `POST /api/v1/admin/applications/sellers/:id/approve`
- **Auth:** staff
- **Behaviour:** marks approved and grants the user the `seller` role.
- **Success:** `200` `{ id, status: "approved" }`
- **Errors:** `404`.

#### `POST /api/v1/admin/applications/sellers/:id/decline`
- **Auth:** staff
- **Body:** `reason` `string` (1–500) **required**
- **Success:** `200` `{ id }`
- **Errors:** `404`.

---

#### `GET /api/v1/admin/applications/providers`
- **Auth:** staff
- **Query:** `page`, `per_page` (default 20)
- **Success:** `200` paginated provider applications (newest first).

#### `POST /api/v1/admin/applications/providers/:id/approve`
- **Auth:** staff
- **Behaviour:** grants the user the `provider` role.
- **Success:** `200` `{ id, status: "approved" }`
- **Errors:** `404`.

#### `POST /api/v1/admin/applications/providers/:id/decline`
- **Auth:** staff
- **Body:** `reason` `string` (1–500) **required**
- **Success:** `200` `{ id }`
- **Errors:** `404`.

---

#### `GET /api/v1/admin/users`
User management list.
- **Auth:** staff
- **Query:** `role` (≤64), `search` (≤100, name/email substring), `page`, `per_page` (default **25**, max 100)
- **Success:** `200` paginated users (newest first). User: `{ id, name, email, roles, is_suspended, suspension_reason, created_at }`.

#### `POST /api/v1/admin/users/:id/suspend`
- **Auth:** **admin only**
- **Body:** `reason` `string` (1–500) **required**
- **Success:** `200` serialized user
- **Errors:** `404`.

#### `POST /api/v1/admin/users/:id/unsuspend`
- **Auth:** **admin only**
- **Success:** `200` serialized user
- **Errors:** `404`.

#### `POST /api/v1/admin/users/:id/assign-role`
- **Auth:** **admin only**
- **Body:** `role` one of `admin | verifier | shop_manager` **required**; `action` `grant | revoke` **required**
- **Success:** `200` serialized user
- **Errors:** `404`.

---

#### `GET /api/v1/admin/markets`
- **Auth:** staff
- **Query:** `state_id`, `page`, `per_page` (default **50**, max 100)
- **Success:** `200` paginated markets ordered by name. Market: `{ id, name, slug, state_id, sublocation_id, address, latitude, longitude, is_active, created_at }`.

#### `POST /api/v1/admin/markets`
- **Auth:** staff
- **Body:** `state_id` **required**, `name` (1–255) **required**, `sublocation_id` optional, `address` (≤500) optional, `latitude` (-90–90) optional, `longitude` (-180–180) optional. Slug auto-generated.
- **Success:** `201` serialized market.

#### `PUT /api/v1/admin/markets/:id`
- **Auth:** staff
- **Body (all optional):** `name`, `address`, `latitude`, `longitude`, `is_active` `boolean`
- **Success:** `200` serialized market
- **Errors:** `404`.

#### `DELETE /api/v1/admin/markets/:id`
- **Auth:** staff
- **Success:** `200` `data: null`
- **Errors:** `404`.

---

#### `GET /api/v1/admin/support/tickets`
Support triage queue.
- **Auth:** staff
- **Query:** `status`, `priority`, `page`, `per_page` (default 20)
- **Success:** `200` paginated tickets (newest first).

#### `POST /api/v1/admin/support/tickets/:id/assign`
- **Auth:** staff
- **Body:** `agent_id` (optional — defaults to the caller). Tickets may only be assigned to an `admin`/`verifier` (`422` otherwise).
- **Success:** `200` ticket ("Ticket DN-SUP-XXXX assigned.")
- **Errors:** `404`, `422`.

---

#### `GET /api/v1/admin/contact-updates`
- **Auth:** staff
- **Query:** `status` (`pending|approved|rejected`), `page`, `per_page` (default 20)
- **Success:** `200` paginated contact-update requests (newest first): `{ id, providerId, proposedChanges, status, reviewedBy, reviewedAt, createdAt }`.

#### `POST /api/v1/admin/contact-updates/:id/approve`
- **Auth:** staff
- **Success:** `200` item ("Contact update approved and applied.")
- **Errors:** `404`; `422` already reviewed.

#### `POST /api/v1/admin/contact-updates/:id/reject`
- **Auth:** staff
- **Success:** `200` item
- **Errors:** `404`; `422` already reviewed.

---

#### `GET /api/v1/admin/adverts`
Advert review queue.
- **Auth:** staff
- **Query:** `status` (`pending|active|expired|unpublished`), `page`, `per_page` (default 20)
- **Success:** `200` paginated adverts (newest first): `{ id, userId, title, status, durationDays, amountPaid, publishedAt, expiresAt, createdAt }`.

#### `GET /api/v1/admin/adverts/stats`
- **Auth:** staff
- **Success:** `200` `{ total, active, pending, expired, revenue }`.

#### `POST /api/v1/admin/adverts/:id/publish`
- **Auth:** staff
- **Behaviour:** sets status `active`, `published_at` now, `expires_at` = now + `duration_days`.
- **Success:** `200` advert
- **Errors:** `404`.

#### `POST /api/v1/admin/adverts/:id/unpublish`
- **Auth:** staff
- **Success:** `200` advert
- **Errors:** `404`.

---

#### `GET /api/v1/admin/listings`
Listing review queue.
- **Auth:** staff
- **Query:** `deal_type`, `status` (`"all"` returns every listing; anything else returns unapproved only), `page`, `per_page` (default 20)
- **Success:** `200` paginated listing-review items (newest first): `{ id, userId, title, dealType, status, approved, featured, promoted, promotionType, promotionExpiry, createdAt }`.

#### `POST /api/v1/admin/listings/:id/approve`
- **Auth:** staff
- **Behaviour:** `approved = true`, `status = "active"`.
- **Success:** `200` item
- **Errors:** `404`.

#### `POST /api/v1/admin/listings/:id/reject`
- **Auth:** staff
- **Body:** `reason` `string` (1–500) **required**
- **Behaviour:** `approved = false`, `status = "inactive"`.
- **Success:** `200` item
- **Errors:** `404`.

#### `POST /api/v1/admin/listings/:id/feature`
- **Auth:** **admin only**
- **Body (all optional):** `featured` `boolean` (default `true`), `promotion_type` `string` (≤60, default `"featured"`), `days` `integer` 1–90 (default 7)
- **Success:** `200` item ("Listing featured." / "Listing removed from featured.")
- **Errors:** `404`.

---

#### `GET /api/v1/admin/notifications/broadcasts`
- **Auth:** **admin only**
- **Query:** `page`, `per_page` (default 20)
- **Success:** `200` `data: { broadcasts: [...] }` + standard `meta`. Broadcast: `{ id, adminId, audience, title, body, type, channels, recipientCount, status, createdAt }`.

#### `POST /api/v1/admin/notifications/broadcast`
Queue a push/email/sms broadcast. **Admin only, throttled** (3 per 60 s per admin → `429`), **dry-run + confirm two-step**, SMS capped at 500 recipients.
- **Auth:** **admin only**
- **Body (JSON):**
  - `title` `string` (1–120) **required**
  - `body` `string` (1–500) **required**
  - `type` `string` (≤60) optional (default `announcement`)
  - `data` `object` optional
  - `channels` `["push"|"email"|"sms"]` optional (default `["push"]`)
  - `audience` `all | role | state | users` optional (default `all`)
  - `role` `string` (≤64) — required when audience is `role`
  - `state` `string` (≤120) — for audience `state`
  - `user_ids` `string[]` (max 1000) — required when audience is `users`
  - `dry_run` `boolean` — preview recipient count, send nothing
  - `confirm` `boolean` — must be `true` to actually queue
- **Success:**
  - `dry_run`: `200` `{ dry_run: true, recipient_count, channels }`
  - confirmed: **`202`** `{ broadcast }` ("Broadcast queued for N recipients.")
- **Errors:** `401`/`403`; `422` missing role/user_ids, no matching recipients, `confirm` not set, SMS over cap; `429` throttled.

---

#### `GET /api/v1/admin/safety-reports`
Safety report moderation queue.
- **Auth:** staff (`admin|verifier`)
- **Query:** `status` (`pending|reviewed|resolved|dismissed|all`), `page`, `per_page`
- **Success:** `200` paginated safety reports with reporter and reported user relations.

#### `POST /api/v1/admin/safety-reports/:id/resolve`
Update status of a safety report.
- **Auth:** staff (`admin|verifier`)
- **Params:** `id` — report ID or UUID
- **Body:** `{ status: "reviewed" | "resolved" | "dismissed", action?: string }`
- **Success:** `200` updated safety report. Notifies reporter of status change.

---

#### `GET /api/v1/admin/stores`
Storefront approval queue.
- **Auth:** staff (`admin|verifier`)
- **Query:** `status` (`pending|active|declined|all`), `page`, `per_page`
- **Success:** `200` paginated stores list.

#### `POST /api/v1/admin/stores/:id/approve`
Approve a store profile and activate its storefront.
- **Auth:** staff (`admin|verifier`)
- **Params:** `id` — store ID or UUID
- **Success:** `200` approved store with `status: "active"`, `isVerified: true`. Notifies store owner.

#### `POST /api/v1/admin/stores/:id/decline`
Decline a store profile with an explanation.
- **Auth:** staff (`admin|verifier`)
- **Params:** `id` — store ID or UUID
- **Body:** `{ reason: string }`
- **Success:** `200` "Store declined." Notifies store owner with reason.

---

#### `GET /api/v1/admin/settings/sms`
Inspect active SMS gateway and configuration status.
- **Auth:** **admin only**
- **Success:** `200` `{ active_provider: "termii" | "twilio", providers: { termii: { configured, active }, twilio: { configured, active } } }`

#### `PUT /api/v1/admin/settings/sms`
Update SMS gateway provider and credentials.
- **Auth:** **admin only**
- **Body:** `{ provider: "termii" | "twilio", termii_api_key?, termii_sender_id?, termii_base_url?, twilio_account_sid?, twilio_auth_token?, twilio_from_number?, twilio_messaging_service_sid?, twilio_verify_service_sid? }`
- **Success:** `200` "SMS settings updated successfully."

#### `POST /api/v1/admin/settings/sms/test`
Send a live test SMS using the active gateway.
- **Auth:** **admin only**
- **Body:** `{ phone: string, message?: string }`
- **Success:** `200` SMS gateway response.

---

## 4. Error handling

Every error response (from either the global `errors` plugin or per-module onError maps) uses the same envelope, with `success: false`, `message`, `data: null` and an optional `errors` payload:

```jsonc
{
  "success": false,
  "message": "Validation failed.",
  "data": null,
  "errors": { /* validator detail or field-message array */ }
}
```

### Status codes

| Code | Meaning | Typical sources |
|---|---|---|
| `200` | OK / success | most reads and updates |
| `201` | Created | register, OTP phone sign-up, kyc submit (first), applications, listings, stores, follow, bookings, reviews, saved searches, adverts, chat sync, tickets, referral register, safety report, media upload, payments initialize, some admin creates |
| `202` | Accepted (deferred) | admin broadcast queued |
| `400` | Malformed request body | `PARSE` errors ("Malformed request body.") |
| `401` | Unauthenticated | missing/invalid/revoked token or header stub; bad login credentials; invalid webhook signature |
| `403` | Forbidden / suspended / insufficient role | suspended account (auth guard, login), non-owner updates, insufficient staff role, missing KYC tier (`403` on applications with explanatory `data`), ticket visibility uses 404 instead |
| `404` | Not found | unknown UUIDs, unknown routes ("Route not found." / "Not found."), scoped resources you can't see, anonymous + no account |
| `409` | Conflict | duplicate email/phone, duplicate pending application, duplicate review, phone already in use |
| `422` | Unprocessable | TypeBox body/query validation ("Validation failed: <path> <message>"), business-rule failures, KYC downgrade/missing files, distress discount < 20%, already-reviewed contact updates, broadcast pre-checks |
| `429` | Too many requests | broadcast throttle (3/min per admin) |
| `500` | Internal error | unhandled errors; DB-backed routes without a live `DATABASE_URL` |
| `502` | Bad gateway | Paystack initialize/verify failures |

### Validation error shape

- **Full modules (auth guard modules):** TypeBox validation collapses to a single message — `422` with `message: "Validation failed: <first path> <first message>"`.
- **Global plugin / marketplace modules:** `422` with `errors` carrying the raw validator output.
- **In-memory modules (adverts, chat, notifications, support, referrals, safety):** `422` with `errors` as an array of human-readable field messages (or `{ index, error }` pairs for chat sync).

### Suspended-account error

The full guard (`applyAuthGuard`) and `POST /auth/login` return:

```jsonc
{
  "success": false,
  "message": "Your account has been suspended. Contact support.",
  "data": null,
  "errors": null
}
```

`status: 403`. (`src/plugins/auth.ts` also defines a `notSuspended` guard that returns the same message with `data: { suspended: true, reason }` should any module adopt it.)

---

## 5. Testing with the API

Live flows live in `docs/http/` as [httpyac](https://httpyac.github.io/) collections (shared env in `docs/http/http-client.env.json`) and cover the full user journey from sign-up to admin review:

| Collection | Covers |
|---|---|
| `01-auth-and-otp-flow.http` | register / login / OTP / profile |
| `02-provider-flow.http` | KYC Tier 1 → provider application → profile → bookings |
| `03-seller-flow.http` | KYC Tier 2 → seller application → store → listings |
| `04-admin-verifier-flow.http` | dashboard, KYC/application/listing/advert review, users, markets, broadcasts |
| `05-listings-and-search-flow.http` | feed, deals, filters, search, favorites |
| `06-notifications-flow.http` | notification centre + push tokens |
| `07-stores-and-follows-flow.http` | storefronts and follows |
| `08-bookings-reviews-payments-flow.http` | booking transitions, reviews, Paystack initialize/verify |
| `09-chat-sync-flow.http` | chat archive + presence |
| `10-adverts-referrals-safety-flow.http` | adverts, referrals, safety reports |
| `9999-logout-flow.http` | logout + token revocation |

Run a suite against a local server:

```bash
npx --yes httpyac docs/http/09-chat-sync-flow.http -e local --all
```

Automated tests: `bun test` (131 tests across 6 files: auth, kyc, marketplace, engagement, payments, admin) exercises the exported `app` via `app.handle()` with the envelope contract. Typecheck with `bunx tsc --noEmit`.