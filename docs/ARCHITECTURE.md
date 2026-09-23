# DistressNow API — Architecture

A **Bun + Elysia + Postgres** port of the Laravel 11 `DistressNowApi` backend.
Same route surface (`/api/v1/...`, 143 endpoints), same response envelope (`{ success, message, data, errors }`),
same domain model — rebuilt on a modern, high-performance TypeScript stack achieving 100% table-for-table schema parity (44 tables).

- Reference backend (read-only): `/home/mich/Projects/DistressNowApi`
- Related clients: `Distressnow-App` (Expo / React Native client), `DistressNow` (web client)
- Documentation: Swagger UI at `/docs`; full endpoint reference in `docs/API.md`; data model in `docs/DATABASE.md`

---

## 1. System Topology

```
                   ┌────────────────────────────────────────────────────────────┐
                   │                     Elysia App (:3000)                     │
                   │  src/index.ts                                              │
                   │  cors · swagger(/docs) · global error envelope handler     │
                   │  GET /health · .group('/api/v1')                           │
                   └──────────────┬───────────────────────────────┬─────────────┘
                                  │                               │
                                  ▼                               ▼
               ┌──────────────────────────────┐    ┌────────────────────────────┐
               │    Core Domain Modules       │    │   Marketplace & Engagement │
               │  auth · kyc · applications · │    │  catalog · locations ·     │
               │  admin · media · payments    │    │  search · listings ·       │
               │                              │    │  stores · view-tracking ·  │
               │                              │    │  item-requests ·           │
               │                              │    │  providers · bookings ·    │
               │                              │    │  reviews · saved-searches ·│
               │                              │    │  adverts · chat ·          │
               │                              │    │  notifications · support · │
               │                              │    │  referrals · safety        │
               └──────────────┬───────────────┘    └──────────────┬─────────────┘
                              │                                   │
                              └─────────────────┬─────────────────┘
                                                │
                                                ▼
               ┌────────────────────────────────────────────────────────────────┐
               │   src/plugins        src/services          src/utils           │
               │   auth (JWT Guard)   termii (SMS/OTP)      response envelope   │
               │   errors (Global)    email (Resend)        pagination          │
               │                      storage (Cloudinary)  phone normalization │
               │                      push (Expo Push)      password (bcrypt)   │
               │                      paystack (Payments)   slugify & lookups   │
               │                                            marketplace helpers │
               └────────────────────────────────┬───────────────────────────────┘
                                                │
                                                ▼
               ┌────────────────────────────────────────────────────────────────┐
               │   src/db  (Drizzle ORM + postgres-js)                          │
               │   schema.ts   → 44 tables (single source of truth)             │
               │   client.ts   → postgres pool singleton (lazy connect)         │
               │   stores.ts   → DB-backed stores with in-memory fallbacks      │
               │   seed.ts     → master data (categories, 37 states,            │
               │                 905 sublocations, 2,613 markets, roles,        │
               │                 staff user accounts)                           │
               └────────────────────────────────┬───────────────────────────────┘
                                                │
                                                ▼
                                   PostgreSQL 16 (distressnow)
```

---

## 2. Layer Responsibilities

| Layer | Path | Responsibility |
|---|---|---|
| **Entry Point** | `src/index.ts` | Configures CORS, Swagger (`/docs`), error handler (`errorsPlugin`), `/health` probe, and mounts all domain modules under `/api/v1`. Exports `app` for zero-overhead in-process testing via `app.handle()`, and only binds the TCP listener when run as the main entry point (`import.meta.main`). |
| **Domain Modules** | `src/modules/<domain>/index.ts` | Cohesive, self-contained domain plugins owning route definitions, TypeBox validation schemas, domain logic, and data store access. |
| **Cross-Cutting Plugins** | `src/plugins/` | `auth.ts`: JWT verification (`applyAuthGuard`, `applyOptionalAuth`), user extraction (`currentUser`), suspension checking, role and KYC tier assertions.<br>`errors.ts`: Global error handler wrapping all TypeBox schema validation errors and runtime failures into the standard response envelope. |
| **External Services** | `src/services/` | Third-party integrations with automatic **mock-mode degradation** when credentials are not configured: `termii.ts` (SMS/OTP), `email.ts` (Resend transactional emails), `storage.ts` (Cloudinary uploads), `push.ts` (Expo push notifications), and `paystack.ts` (payment initialization, verification, and webhook signature validation). |
| **Data Access & Schema** | `src/db/` | `schema.ts`: 44 tables defining PostgreSQL tables, enums, foreign keys, and indexes via Drizzle ORM.<br>`client.ts`: Lazy singleton connection pool over `postgres-js`.<br>`stores.ts`: Database-backed repository implementations with in-memory fallbacks.<br>`seed.ts`: Complete seed script for roles, categories, states, sublocations, markets, and staff. |
| **Shared Utilities** | `src/utils/` | Response builders (`ok()`, `created()`, `fail()`, `paginated()`), pagination calculators (`parsePagination()`, `buildMeta()`), E.164 phone normalization, bcrypt hashing, slug generation, identifier resolvers, and marketplace domain helpers. |

---

## 3. Request Lifecycle

1. **Routing & CORS**: The incoming request hits Elysia and passes through CORS headers and URL normalizations.
2. **Schema Validation**: Request bodies, query parameters, and route parameters are validated against **TypeBox** schemas declared on each route. Any validation failure immediately routes through the global error plugin, yielding a structured `422 Unprocessable Entity` envelope with detailed field error diagnostics.
3. **Authentication & Authorization**:
   - Routes wrapped with `applyAuthGuard` extract the Bearer token from the `Authorization` header, verify the HS256 signature using `@elysiajs/jwt`, and load the active user from the UserStore.
   - Unauthenticated callers receive `401 Unauthorized`.
   - Suspended accounts are halted with `403 Forbidden` (`is_suspended` check).
   - Role requirements (e.g. `role:admin|verifier` or `role:admin`) and KYC tier requirements (`tier >= 1` for providers, `tier >= 2` for sellers) enforce capability boundaries.
   - Public and hybrid routes (e.g. referrals, webhook, view tracking) use `applyOptionalAuth` to resolve `currentUser` without rejecting unauthenticated traffic.
4. **Domain Execution & Store Operations**: Handlers operate against repository stores (`src/db/stores.ts` or specialized module stores). When PostgreSQL is available, queries execute via Drizzle ORM; during unit tests or offline environments, in-memory state fallbacks ensure deterministic behavior.
5. **Response Envelope**: All endpoints return uniform JSON matching the contract:
   ```jsonc
   {
     "success": true,        // boolean
     "message": "...",       // human-readable status message
     "data": { ... },        // payload object, array, or null
     "errors": null,         // error map or null
     "meta": { ... }         // optional pagination metadata: current_page, per_page, total, last_page
   }
   ```

---

## 4. Authentication, Authorization & Identity

- **JWT Tokens**: Login, registration, OTP verification, and password reset endpoints mint JWTs containing `{ sub: userId }` with a 7-day expiration time, matching Laravel Sanctum session longevity.
- **Role System**: Users can hold multiple simultaneous roles (`admin`, `verifier`, `shop_manager`, `seller`, `provider`, `buyer`) modeled after Spatie Laravel Permission tables (`roles`, `permissions`, `model_has_roles`, `model_has_permissions`, `role_has_permissions`).
- **Graduated KYC Verification**:
  - `Tier 0`: Unverified buyer.
  - `Tier 1`: Identity verification (NIN front/back, selfie photo). Prerequisite for Service Provider role application.
  - `Tier 2`: Business verification (CAC certificate, SMEDAN number, business address, CAC document uploads). Prerequisite for Seller / Store creation.
  - Profile downgrades from an approved status are blocked.
- **Real JWT Guard Throughout**: Every module in the rebuild uses genuine JWT validation (`applyAuthGuard` / `applyOptionalAuth`). No legacy header stubs remain.

---

## 5. Domain Subsystems

### 5.1 "Request an Item" (Buyer Want-Ads & Store Matching)
- **Module**: `src/modules/item-requests/index.ts`
- **Purpose**: Enables buyers to broadcast item requests ("want-ads") with target categories, locations, budget ranges, and photos.
- **Two-Pool Store Matching Engine**:
  - Automatically scores candidate stores based on sublocation proximity (+40 points), state proximity (+20 points), and category affinity (+30 points).
  - Divides matching stores into two distinct pools:
    1. **Promoted Pool**: Up to 15 slots reserved for paid promoted stores (`is_promoted = true` and valid expiry).
    2. **Organic Pool**: Up to 15 slots for organic candidate stores.
  - Fanned-out via automated in-app notifications (`item_request_broadcast`) with direct links for sellers to submit quotes.
- **Offer Submissions**: Verified sellers review requests and submit formal offers (`price`, `message`, optional `listing_id`, images).

### 5.2 View Tracking & Engagement
- **Module**: `src/modules/view-tracking/index.ts`
- **Purpose**: Real-time traffic analytics across Stores, User Profiles, and Service Providers.
- **5-Minute Anti-Spam Throttle**: Views originating from the same authenticated user or client IP address within 5 minutes are deduplicated.
- **Push & In-App Alerts**: Unthrottled views trigger instant alerts to the store, profile, or provider owner, enriched with:
  - 1-click visitor chat links: `/chat?recipient_id={viewer_id}`
  - Direct profile URLs: `/user/{viewer_id}`
  - Viewer identity and avatar
- **Analytics Endpoints**:
  - `GET /api/v1/user/stores/:id/analytics`: Store views count, followers count, and paginated recent viewers.
  - `GET /api/v1/user/profile/analytics`: Profile views count and paginated recent viewers.
  - `GET /api/v1/user/providers/:id/analytics`: Provider views count and paginated recent viewers.

### 5.3 Notification Preferences & Centre
- **Module**: `src/modules/notifications/index.ts`
- **Preferences API**: `GET /api/v1/notifications/settings` and `PUT/PATCH /api/v1/notifications/settings`.
- **Dual-Key Compatibility**: Supports and returns both `snake_case` (backend/DB standard) and `camelCase` (mobile client standard) preferences (e.g. `push_enabled`, `pushEnabled`, `email_hot_deals`, `push_new_messages`, `view_notifications_push`).
- **Channel Routing**: Tracks delivery stamps for in-app rows (`read_at`), push tokens (`pushed_at`), email delivery (`emailed_at`), and SMS (`smsed_at`).

### 5.4 Polymorphic Reviews
- **Module**: `src/modules/reviews/index.ts`
- **Polymorphic Targets**: Supports rating and reviewing stores, service providers, product listings, and sellers/users.
- **Resilient Parameter Aliasing**: Accepts `reviewable_type` / `target_type` / `type` and `reviewable_id` / `target_id` / `id`.
- **Multi-Format Resolvers**: Resolves target entities seamlessly by UUID, numeric primary key, or URL slug.
- **Aggregate Recalculation**: Submitting a review automatically updates the target store or provider's aggregate rating and review counters, and dispatches a `review_received` notification to the entity owner.

### 5.5 Admin Queues & Operations
- **Module**: `src/modules/admin/index.ts`
- **Review Queues**:
  - KYC verification triage (tier 1/tier 2 document inspection, approval, rejection with notes).
  - Seller and Provider role application review.
  - Store storefront moderation (approve/activate, decline with reasons).
  - Safety and abuse reports queue (investigate, resolve, dismiss).
  - Provider contact-change requests (approve/reject proposed phone/whatsapp updates).
  - Classified listings moderation (distress deals, deal of the day, featured tags).
- **Operations & Broadcasts**:
  - User suspension and role assignment.
  - Bounded mass notification broadcasts across push, SMS, and email.
  - SMS gateway configuration (`termii` / `twilio`) and live test sending.

---

## 6. Database Schema (44 Tables)

All 44 tables are defined in [`src/db/schema.ts`](file:///home/mich/Projects/distressnow-elysia-api/src/db/schema.ts), mirroring Laravel reference migrations table-for-table:

| Group | Tables |
|---|---|
| **Auth & Identity** (8) | `users`, `password_reset_tokens`, `otp_codes`, `roles`, `permissions`, `model_has_roles`, `model_has_permissions`, `role_has_permissions` |
| **Verification & Applications** (3) | `kyc_profiles`, `seller_applications`, `provider_applications` |
| **Catalog & Geography** (5) | `categories`, `subcategories`, `states`, `sublocations`, `markets` |
| **Marketplace: Stores, Providers & Bookings** (8) | `stores`, `store_follows`, `store_views`, `service_providers`, `service_provider_views`, `contact_updates`, `bookings`, `reviews` |
| **Marketplace: Item Requests** (2) | `item_requests`, `item_request_responses` |
| **Marketplace: Listings** (5) | `listings`, `listing_images`, `favorite_listings`, `recently_viewed_listings`, `saved_searches` |
| **Engagement: Chat & Notifications** (5) | `chat_messages`, `notifications`, `device_tokens`, `notification_broadcasts`, `profile_views` |
| **Engagement: Support, Adverts, Safety** (5) | `support_tickets`, `support_messages`, `adverts`, `referral_attributions`, `safety_reports` |
| **Operations, Ledger & Settings** (3) | `transactions`, `admin_logs`, `system_settings` |

Detailed column types, foreign keys, and indexes are documented in [`docs/DATABASE.md`](file:///home/mich/Projects/distressnow-elysia-api/docs/DATABASE.md).

---

## 7. Comparison: Laravel 11 Reference vs. Elysia Rebuild

| Architectural Dimension | Laravel 11 (`DistressNowApi`) | Elysia Rebuild (`distressnow-elysia-api`) | Notes |
|---|---|---|---|
| **Runtime & Framework** | PHP 8.3 + Laravel 11 | Bun 1.4 + Elysia 1.4 | Significant memory reduction and sub-millisecond route dispatch latency. |
| **Routes & Organization** | Monolithic `routes/api.php` (359 lines) calling ~45 controllers | 20 modular domain plugins under `src/modules/` | Modular layout grouping routes, validation, and domain logic cohesively. |
| **Endpoint Count** | 143 endpoints under `/api/v1` | 143 endpoints under `/api/v1` | Complete feature and path parity. |
| **Schema & Database** | 37 migration files (Eloquent ORM) | 1 Drizzle ORM schema (`src/db/schema.ts`, 44 tables) | Drizzle generates and runs SQL migrations directly against Postgres. |
| **Response Format** | Inconsistent across controllers (Resource classes, raw responses) | Strict `{ success, message, data, errors, meta? }` envelope | Handled automatically via response helpers and global error plugin. |
| **Auth Guard** | Laravel Sanctum bearer tokens | `@elysiajs/jwt` tokens (`{ sub }`, 7-day TTL) | Identical role checks, KYC tier gates, and suspension rules. |
| **Transactional Email** | Laravel Mail / SMTP | Resend API client (`src/services/email.ts`) | Automatic log mock-mode fallback when `RESEND_API_KEY` is omitted. |
| **SMS & OTP** | Termii HTTP Client | Termii service (`src/services/termii.ts`) | Same 6-digit OTP expiration and verification semantics. |
| **Media Storage** | Local filesystem / AWS S3 | Cloudinary (`src/services/storage.ts`) | Direct upload and signed URL handling. |
| **Realtime Chat** | Firebase RTDB + archive API endpoints | Firebase RTDB + archive API endpoints | Preserves architecture: Firebase handles realtime sockets; API archives messages. |
| **Test Engine** | PHPUnit (34 files) | `bun:test` (9 files, 182 tests) | Sub-second test execution against in-memory stores. |

---

## 8. Testing & Quality Assurance

The codebase enforces strict quality gates before any deployment:

1. **Automated Unit & Feature Tests (`bun test`)**:
   - **182 passing tests** across 9 test files.
   - Tests run in-process against `app.handle()` with isolated in-memory stores for instant execution (< 10 seconds total run time).
   - Test suites:
     - `tests/auth.test.ts`: Registration, login, OTP verification, password reset flows.
     - `tests/kyc.test.ts`: Tier-1 and Tier-2 document submission, status transitions, role application rules.
     - `tests/marketplace.test.ts`: Categories, locations, listings CRUD, deals, search, ratings validation.
     - `tests/item-requests.test.ts`: Want-ad creation, two-pool matching, seller offers, lifecycle transitions.
     - `tests/view-tracking-and-stores.test.ts`: Store directories, 5-min throttle views, analytics, follower flows, provider views, notification preferences, flexible reviews.
     - `tests/engagement.test.ts`: Chat sync, presence heartbeat, support tickets, reviews.
     - `tests/payments.test.ts`: Paystack transaction initialization, verification, and webhook handling.
     - `tests/admin.test.ts`: Admin dashboard metrics, moderation queues, store reviews, safety reports, SMS configuration.
     - `tests/broadcast.test.ts`: Mass notification concurrency bounds, push/SMS/email broadcast dispatching.

2. **Type Checking (`bunx tsc --noEmit`)**:
   - Zero TypeScript compilation errors across all modules, tests, and configuration files.

3. **Live E2E Verification**:
   - Comprehensive HTTP test flows in `docs/http/` executable via `httpyac` against live running services.

---

## 9. Deployment Architecture

- **Containerization**:
  - `docker-compose.yml`: Multi-stage Docker container running `oven/bun:1-alpine` linked to a `postgres:16-alpine` database.
- **Environment Management**:
  - Validated on boot via `src/env.ts` with Zod schemas.
  - Production secrets kept out of version control; sample definitions maintained in `.env.example`.
- **Database Migrations**:
  - Generate migration SQL: `bun run db:generate`
  - Apply migrations in production: `bun run db:migrate`
  - Dev quick-push: `bun run db:push`
  - Seed master data: `bun run db:seed`
- **Observability**:
  - Health check: `GET /health` returns JSON system status and database connectivity.
  - OpenAPI / Swagger UI: `GET /docs` provides interactive API documentation.