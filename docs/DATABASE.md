# DATABASE.md — Postgres data model

The API persists to Postgres through **drizzle-orm + postgres-js**. The schema is defined
in TypeScript (`src/db/schema.ts`) and mirrors the Laravel reference migrations in
`DistressNowApi/database/migrations/*.php` table-for-table (38 tables).

## Connection / client

`src/db/client.ts` exports a lazy singleton:

- `sql` — a `postgres-js` client pool (`max: 10` connections, `prepare: false`).
  Importing the module **never opens a socket**; the first query connects. This is what
  lets `/health` and the test suite boot without a live database.
- `db` — the drizzle instance (`drizzle(sql, { schema })`) used by every query in the app.

The pool is memoised on `globalThis.__distressnowSql` (in non-production) so hot-reload
(`bun run --watch`) doesn't leak connections.

The connection URL is `DATABASE_URL` (default
`postgres://postgres:postgres@localhost:5432/distressnow`, see `src/env.ts`).

## Table inventory (38 tables, grouped by domain)

> Conventions carried over from Laravel (see schema header comment):
> `$table->id()` → `bigserial` PK; a **separate `uuid` column** (`defaultRandom()`,
> unique) is the *public* id used for route binding wherever the migration defines one
> — the `users` table is the exception and has **no** uuid column (see below).
> `$table->timestamps()` → `created_at`/`updated_at` (timestamptz),
> `$table->softDeletes()` → nullable `deleted_at`, `$table->enum()` → `pgEnum`.

### Auth / identity

| Table | Purpose / key columns |
|---|---|
| `users` | Accounts. `bigserial` PK, **no uuid** — public id is `String(users.id)` (the whole codebase treats user ids as strings, looped through JWT `sub`). Unique `email` and `phone` (varchar 20, stored/queried as E.164 `+234…`), bcrypt `password`, `auth_provider`, `provider_id`, email/phone `*_verified_at`, `onboarding_completed`, `location_state`/`location_sublocation`, `interests` (jsonb). Suspension: `is_suspended`, `suspension_reason`, `suspended_at`, `suspended_by`. Chat presence: `presence_status`, `last_seen_at`, `typing_in_conversation`, `typing_at`. Index: `users_last_seen_at_idx`. |
| `password_reset_tokens` | Text PK `email` → `token`, `created_at` (Laravel `password_reset_tokens` shape). |
| `otp_codes` | OTP verification codes. `identifier` + `type` (enum), `code` varchar(10), `expires_at`, `used_at`, `attempts`, `created_at`/`updated_at`. Index: `otp_codes_identifier_type_idx`. Note: the column is `varchar(10)` — too small for the SHA-256 hash the in-memory store keeps, so the **plain 6-digit code** is persisted (Laravel `TermiiService::sendOtp` parity). |
| `kyc_profiles` | One per user (`user_id` unique FK). `tier` smallint (0 none / 1 identity / 2 business), `status` (`kyc_status` enum: pending/approved/rejected), `rejection_reason`; tier-1 NIN/selfie paths; tier-2 business fields + CAC/SMEDAN paths; review trail (`reviewed_by` FK, `reviewed_at`, `submitted_at`). |
| `seller_applications` | Store-owner applications. FK `user_id`, required FK `kyc_profile_id` (`onDelete: restrict`); store name/desc/phone/email/state/sublocation/market/categories (jsonb)/logo/address/lat/lng; `status` (`application_status`: pending/approved/declined), `declined_reason`, review trail. Index: `seller_applications_user_status_idx`. |
| `provider_applications` | Service-provider applications. FK `user_id`, FK `kyc_profile_id`; full name, business, bio, `service_categories` (jsonb), `years_experience`, `price_range`, `response_time`, `availability` (`provider_application_availability`), location + lat/lng, contact phone/whatsapp, photo; status/review trail. Index: `provider_applications_user_status_idx`. |

### Roles & permissions (spatie/laravel-permission shape)

| Table | Purpose / key columns |
|---|---|
| `roles` | `name` + `guard_name` (unique pair). Seeded set: `admin`, `verifier`, `shop_manager`, `seller`, `provider`, `buyer` — all `sanctum` guard. |
| `permissions` | `name` + `guard_name` (unique pair). |
| `model_has_roles` | Polymorphic role assignment: `role_id` FK cascade, `model_type` (the codebase uses `"App\\Models\\User"`), `model_id`. Composite PK `(role_id, model_id, model_type)`, index `model_has_roles_model_idx`. |
| `model_has_permissions` | Polymorphic direct permission grant. Composite PK `(permission_id, model_id, model_type)`. |
| `role_has_permissions` | Role↔permission junction. Composite PK `(permission_id, role_id)`. |

### Catalog / location

| Table | Purpose / key columns |
|---|---|
| `categories` | Marketplace categories: `uuid` (public id), unique `slug`, `icon`, `image_path`, `sort_order`, `is_active`. |
| `subcategories` | `uuid`, FK `category_id` (cascade), `slug` unique per category (`subcategories_category_slug_unique`). |
| `states` | Nigerian states (37 incl. Abuja/FCT): `uuid`, unique `name`, unique `slug`, `code`, `is_active`. |
| `sublocations` | Cities/areas: `uuid`, FK `state_id`, slug unique per state (`sublocations_state_slug_unique`). |
| `markets` | ~2,600 markets: `uuid`, FK `state_id`, nullable FK `sublocation_id`, slug unique per state (`markets_state_slug_unique`), `address`, lat/lng. |

### Marketplace — stores & providers

| Table | Purpose / key columns |
|---|---|
| `stores` | Storefronts: `uuid`, FK `user_id`, unique `slug`, contact info, nullable FKs to `state_id`/`sublocation_id`/`market_id`, `categories`/`social_links`/`opening_hours` (jsonb), counters (`rating`, `review_count`, `listings_count`, `followers_count`), `is_verified`, `status`, `verified_at`, `last_active_at`. Indexes: `stores_state_sublocation_idx`, `stores_verified_status_idx`. |
| `store_follows` | FK `user_id` + FK `store_id`, unique per user+store (`store_follows_user_store_unique`), index on store. |
| `service_providers` | Published provider profiles: `uuid`, FK `user_id`, unique `slug`, `service_categories` (jsonb), `availability` (`provider_availability`, distinct 2-value pg type), location FKs, `is_verified`, `rating`, counters. Indexes: `service_providers_state_sublocation_idx`, `service_providers_verified_idx`, `service_providers_availability_idx`. |
| `contact_updates` | Pending provider contact-info change requests: FK `provider_id`, `requested_by`, `proposed_changes` (jsonb), `status`, review trail. Index: `contact_updates_status_created_idx`. |
| `bookings` | Provider bookings: `uuid`, FK `user_id` + `provider_id`, service type/description, `preferred_date`/time, location, `quoted_price`/`final_price` (decimal 12,2), text `status`, cancellation + lifecycle timestamps (`accepted_at`, `started_at`, `completed_at`, `cancelled_at`). Indexes: `bookings_user_status_idx`, `bookings_provider_status_idx`, `bookings_preferred_date_idx`. |
| `reviews` | Polymorphic rating (Store | ServiceProvider via `reviewable_type`/`reviewable_id`, no FK), optional `booking_id`, `rating` smallint, `comment`, `reply` + `replied_by`/`replied_at`, `uuid`. Indexes: `reviews_reviewable_rating_idx`, `reviews_user_idx`. |

### Marketplace — listings

| Table | Purpose / key columns |
|---|---|
| `listings` | Product/service listings: `uuid`, FK `user_id` (required), nullable FK `store_id`, FKs `category_id` + `state_id` (`onDelete: restrict`), nullable `subcategory_id`/`sublocation_id`, `category_specific_fields` (jsonb), unique `slug`. Pricing (`price`, `discount_price`, `discount_percentage`, `is_discounted`), details (`condition`, `listing_scope`, `deal_type`), approval (`status` text default `pending`, `approved` bool), promotion (`promoted`, `promotion_type`, `promotion_expiry`, `featured`), analytics counters (`views_count`, `clicks_count`, `favorites_count` — bigint), lat/lng, soft delete. Indexes: `listings_status_category_idx`, `listings_deal_type_idx`, `listings_promoted_idx`. |
| `listing_images` | FK `listing_id` (cascade), `path`, `url`, `is_primary`, soft delete. |
| `recently_viewed_listings` | FK `user_id` + `listing_id`, `viewed_at`, unique per user+listing. |
| `favorite_listings` | FK `user_id` + `listing_id`, unique per user+listing, soft delete. |
| `saved_searches` | FK `user_id`, `name`, `filters` (jsonb). Index `saved_searches_user_created_idx`. |

### Engagement — chat

| Table | Purpose / key columns |
|---|---|
| `chat_messages` | **Archive** of chat messages — Firebase RTDB stays the realtime store; this table is the durable log. `conversation_id` (the client's Firebase key, varchar 191), `participant_key`, `client_message_id` (varchar 128), FKs `sender_id`/`receiver_id`, `message`, `message_type` (`chat_message_type`: text/image/file), `attachment_url` (varchar 2048), `read_at`, soft delete. Unique dedupe `chat_messages_client_dedupe_unique` on `(conversation_id, sender_id, client_message_id)`; indexes for conversation/participant/read scans. |

### Engagement — notifications, devices, broadcasts

| Table | Purpose / key columns |
|---|---|
| `notifications` | In-app notification feed: FK `user_id`, `type` (varchar 60), `title`, `body`, `data` (jsonb), `read_at`, and per-channel delivery stamps — `pushed_at`, `emailed_at`, `smsed_at`. Indexes: `notifications_user_read_idx`, `notifications_user_created_idx`. |
| `device_tokens` | Expo push-token registry: FK `user_id`, unique `token`, `platform` (`device_platform`: ios/android/web), `device_name`, `last_used_at`. Index `device_tokens_user_platform_idx`. |
| `notification_broadcasts` | Admin announcements: FK `admin_id`, `audience` (`broadcast_audience`: all/role/state/users) + `audience_role`/`audience_state`/`audience_user_ids` (jsonb), `channels` (jsonb), `status` (`broadcast_status`: queued/sending/sent/failed), `recipient_count`/`sent_count`, `started_at`/`completed_at`. |

### Engagement — support, adverts, referrals, safety

| Table | Purpose / key columns |
|---|---|
| `support_tickets` | Unique `ticket_number`, FK `user_id`, `subject`, `category` (`ticket_category`), `priority` (`ticket_priority`), `status` (`ticket_status`), `platform` (`ticket_platform`), `last_message`/`last_message_at`, `assigned_to`, `resolved_at`/`closed_at`. Indexes: `support_tickets_user_status_idx`, `support_tickets_status_priority_idx`, `support_tickets_last_message_at_idx`. |
| `support_messages` | FK `support_ticket_id` (cascade), FK `user_id` (set null), `sender_type` (`sender_type`: user/support/system), `message`, `attachments` (jsonb), `read_at`. Index: `support_messages_ticket_created_idx`. |
| `adverts` | `uuid`, FK `user_id`, `listing_id` is the **listing uuid without an FK** (mirrors Laravel `foreignUuid`), title/description/image/target, `duration_days` (default 7), `status`, `amount_paid`, `published_at`/`expires_at`. Indexes: `adverts_status_expires_idx`, `adverts_user_idx`. |
| `referral_attributions` | `uuid`, FK `user_id` (set null), `referral_code`, `campaign_id`, `status`, FK `registered_user_id`, `metadata` (jsonb), `registered_at`/`converted_at`. Indexes: `referral_attributions_code_idx`, `referral_attributions_status_created_idx`. |
| `safety_reports` | `uuid`, FK `reporter_id`, `report_type` (varchar 40), `message`, `listing_id` (uuid, no FK), FK `reported_user_id` (set null), `status`. Indexes: `safety_reports_status_created_idx`, `safety_reports_reporter_idx`. |

### Payments / admin / transactions

| Table | Purpose / key columns |
|---|---|
| `transactions` | Payment ledger: `uuid`, FK `user_id`, nullable FK `booking_id`, unique `reference` + `paystack_reference`, `amount` decimal(12,2) **and** `amount_kobo` integer, `currency` (varchar 3, default `NGN`), `channel`, `status` (text), `gateway_response`, `ip_address`, `metadata`/`authorization` (jsonb), `paid_at`. Indexes: `transactions_user_status_idx`, `transactions_reference_idx`. |
| `admin_logs` | Admin audit trail: FK `admin_id`, `action`, `target_type`/`target_id`, `details` (jsonb), `created_at`. Indexes: `admin_logs_admin_created_idx`, `admin_logs_target_idx`. |

## Enums (16 `pgEnum` types)

Defined in `src/db/schema.ts`, listed by exporting name → SQL type → values:

| Export | PG type | Values |
|---|---|---|
| `authProviderEnum` | `auth_provider` | `email`, `phone`, `google`, `apple` |
| `presenceStatusEnum` | `presence_status` | `online`, `away`, `offline` |
| `kycStatusEnum` | `kyc_status` | `pending`, `approved`, `rejected` |
| `applicationStatusEnum` | `application_status` | `pending`, `approved`, `declined` |
| `otpTypeEnum` | `otp_type` | `phone_signup`, `email_signup`, `phone_reset`, `email_reset` |
| `ticketCategoryEnum` | `ticket_category` | `general_inquiry`, `report_issue`, `account_services`, `listing_issues`, `verification_issues`, `billing`, `other` |
| `ticketPriorityEnum` | `ticket_priority` | `low`, `normal`, `high`, `urgent` |
| `ticketStatusEnum` | `ticket_status` | `open`, `pending`, `resolved`, `closed` |
| `ticketPlatformEnum` | `ticket_platform` | `mobile`, `web`, `unknown` |
| `senderTypeEnum` | `sender_type` | `user`, `support`, `system` |
| `devicePlatformEnum` | `device_platform` | `ios`, `android`, `web` |
| `broadcastAudienceEnum` | `broadcast_audience` | `all`, `role`, `state`, `users` |
| `broadcastStatusEnum` | `broadcast_status` | `queued`, `sending`, `sent`, `failed` |
| `providerApplicationAvailabilityEnum` | `provider_application_availability` | `immediate`, `scheduled`, `busy`, `weekends`, `unavailable` |
| `providerAvailabilityEnum` | `provider_availability` | `immediate`, `scheduled` (distinct type — see `service_providers`) |
| `chatMessageTypeEnum` | `chat_message_type` | `text`, `image`, `file` |

Some statuses are deliberately plain `text`/`varchar` columns (e.g. `stores.status`,
`bookings.status`, `adverts.status`, `transactions.status`, `contact_updates.status`,
`safety_reports.status`) mirroring Laravel string columns — only columns that were
Postgres enums in the reference became `pgEnum`s.

## Key relations & FK behavior

- Cascade-delete chains: `users` → `kyc_profiles`, `seller_applications`,
  `provider_applications`, `notifications`, `device_tokens`, `bookings`, `transactions`,
  `chat_messages`, `stores`, `store_follows`, `favorite_listings`, etc. via
  `onDelete: "cascade"`.
- `kyc_profiles.id` is required by both application tables (`onDelete: "restrict"`) —
  a KYC profile can't be deleted while an application references it. The KYC store
  resolves the profile id before inserting an application (see `src/db/stores.ts`).
- `users` has no `uuid` column; identity flows (JWT `sub`, FKs) use
  `String(users.id)`. Catalog/marketplace tables use `uuid` as the public id.
- `reviews` and adverts/safety `listing_id` are polymorphic / uuid-without-FK — they
  deliberately carry no relational constraint.
- `model_type` for permission assignment is `"App\\Models\\User"` (matches seeds).

## Indexes

Every index in the schema (28 total across the tables above) targets the hot query
paths: user-scoped status lists (`user_status_idx`), location joins
(`stores_state_sublocation_idx`, `service_providers_state_sublocation_idx`), dedupe /
unique lookups (slugs, references, follow/favorite/recently-viewed pairs), and
order-by timestamp scans (feed/recently-created). `drizzle-kit` emits them inside
the single 0000 migration.

## Schema → migrations workflow

The SQL migration chain is generated from the TS schema (mirroring Laravel's
`php artisan make:migration` → `php artisan migrate` cycle):

1. **Edit the source of truth** — `src/db/schema.ts` (never hand-edit SQL).
2. `bun run db:generate` — runs `drizzle-kit generate`; diffs the schema and writes a
   new numbered SQL file into `drizzle/` (the initial import is
   `drizzle/0000_huge_terrax.sql`; journal lives in `drizzle/meta/`).
3. Review the generated SQL in `drizzle/` before applying.
4. Apply with either:
   - `bun run db:push` — `drizzle-kit push`; syncs `DATABASE_URL` straight from the
     schema (fast for dev, non-journaled), or
   - `bun run db:migrate` — `drizzle-kit migrate`; replays the journaled migrations.

`drizzle.config.ts` points `schema` at `src/db/schema.ts`, `out` at `./drizzle`, and
defaults `DATABASE_URL` to the local docker-compose Postgres.

## Seeding

`bun run db:seed` executes `src/db/seed.ts`, mirroring the Laravel seeders. It is
**idempotent** — upserts keyed by slug/email — so re-running is safe:

| Seed | Source | Counts |
|---|---|---|
| Roles | hardcoded `roleNames` | 6 roles (`admin`, `verifier`, `shop_manager`, `seller`, `provider`, `buyer`), guard `sanctum` |
| Categories + subcategories | hardcoded `CATEGORY_DATA` | **15 categories** with their subcategories |
| States + sublocations | hardcoded `STATE_DATA` | **37 states** (incl. Abuja/FCT) with city-level sublocations |
| Markets | `src/db/data/markets.json` (parsed at seed time) | **2613 markets**, 37 distinct states, ~**905 sublocations** after market import (the loader also upserts missing sublocations inline), lat/lng + address |
| Staff users | hardcoded `STAFF_USERS` | **5 staff users** (2 admin, 1 verifier, 2 shop_manager) with bcrypt password `18781875`; each gets `buyer` + their staff role |

The script prints final row counts
(`roles/categories/subcategories/states/sublocations/markets/users`) and closes the pool.

## DB-backed stores with in-memory fallback (`src/db/stores.ts`)

Auth, KYC and role-application persistence sit behind store **interfaces** whose
default implementations are in-memory (unit-testable, no DB). `src/db/stores.ts`
provides Postgres-backed factories with the *same* public surface:

- `createDbUserStore()` → over `users` + `model_has_roles` (roles re-read per lookup;
  default `buyer` role assigned on create — `assignRoleSafely` parity). Public ids are
  `String(users.id)`.
- `createDbOtpStore()` → over `otp_codes`; identical TTL (10 min) / max-attempts (5) /
  single-use semantics to `MemoryOtpStore`, but stores the **plain code**
  (`otp_codes.code` is varchar(10)).
- `createDbKycStore()` → over `kyc_profiles`; maps documents to the `*_path` columns and
  mirrors the full `documents[]`/`fields{}` payload into the `store_categories` jsonb
  under the reserved `__dn` key so unknown/generic attachments round-trip.
- `createDbSellerApplicationStore()` / `createDbProviderApplicationStore()` → over the
  application tables; resolve `kyc_profiles.id` (required NOT NULL FK) before insert.

**Boot-time auto-detection:** at module load the client runs a 3-second probe
(`select 1`). If `DATABASE_URL` is reachable, `getDbStores()` hands the shared DB
stores to the auth/KYC/applications plugin factories; otherwise they fall back to the
in-memory singletons and a single warning is logged. Tests pin explicit in-memory
stores via plugin options, so the test suite never touches the DB.