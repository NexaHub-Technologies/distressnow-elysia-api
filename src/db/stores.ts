/**
 * Postgres-backed persistence overlays for the auth / kyc / applications
 * in-memory stores.
 *
 * The single source of truth for behaviour is the in-memory implementations:
 *  - UserStore            -> src/modules/auth/index.ts  (MemoryUserStore)
 *  - OtpStore             -> src/services/termii.ts     (MemoryOtpStore)
 *  - KycStore             -> src/modules/kyc/index.ts   (MemoryKycStore)
 *  - Seller/Provider apps -> src/modules/applications/index.ts
 *
 * These factories implement the SAME public interfaces so the modules can
 * swap the default stores at plugin construction time without touching any
 * route code. Tests keep passing explicit in-memory stores, so they stay on
 * the memory path regardless of DATABASE_URL.
 *
 * Id mapping: `users.id` is a bigint; the public AuthUser.id is a string (and
 * the whole codebase treats it as a string). Unlike categories/states/etc.
 * the Laravel `users` table has NO `uuid` column, so the public id here is
 * `String(users.id)` — it round-trips as the JWT `sub` and DB FK.
 *
 * OTP storage note: the migration defines `otp_codes.code` as varchar(10),
 * which cannot hold the SHA-256 hex the in-memory store keeps. This store
 * persists the plain 6-digit code — exactly what the Laravel reference
 * (TermiiService::sendOtp) writes — and mirrors the MemoryOtpStore
 * TTL/attempt/single-use semantics otherwise.
 *
 * KYC storage note: kyc_profiles has no `documents`/`fields` jsonb columns
 * (the schema predates them). Documents map onto the dedicated *_path
 * columns, text fields onto their columns, and the full documents[]/fields{}
 * payload is additionally mirrored into the (otherwise unused) store_categories
 * jsonb under the reserved `__dn` key so generic `document` attachments and
 * unknown fields round-trip.
 */
import { and, desc, eq, isNull } from "drizzle-orm";
import { db, sql as sqlClient } from "./client";
import {
  kycProfiles,
  modelHasRoles,
  otpCodes,
  providerApplications,
  roles,
  sellerApplications,
  users,
} from "./schema";
import {
  OTP_MAX_ATTEMPTS,
  OTP_TTL_MS,
  OtpError,
  type OtpType,
} from "../services/termii";
import { generateOtpCode, normalizeEmail, normalizePhone, nowIso } from "../utils/phone";
import { env } from "../env";

// Type-only imports — erased at runtime, so stores.ts never participates in a
// runtime import cycle with the modules that consume these factories.
import type {
  AuthUser,
  CreateUserInput,
  UserStore,
} from "../modules/auth/index";
import type { KycDocument, KycRecord, KycStatus } from "../modules/kyc/index";
import type { ProviderApplication, SellerApplication } from "../modules/applications/index";

// ── Shared helpers ──────────────────────────────────────────────────────────

/** model_type used by spatie/laravel-permission (matches the seed data). */
const MODEL_TYPE = "App\\Models\\User";

/** Reserved key inside kyc_profiles.store_categories carrying full fidelity. */
const KYC_EXTRA_KEY = "__dn";

function toIso(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function toDate(value: string | number | Date | null | undefined): Date | null {
  if (value == null) return null;
  return value instanceof Date ? value : new Date(value);
}

// ── Users ───────────────────────────────────────────────────────────────────

function rowToAuthUser(
  row: typeof users.$inferSelect,
  roleNames: string[],
): AuthUser {
  return {
    id: String(row.id),
    name: row.name,
    email: row.email,
    phone: row.phone,
    passwordHash: row.password,
    auth_provider: row.authProvider,
    provider_id: row.providerId,
    email_verified_at: toIso(row.emailVerifiedAt),
    phone_verified_at: toIso(row.phoneVerifiedAt),
    is_suspended: row.isSuspended,
    roles: roleNames,
    whatsapp_number: row.whatsappNumber,
    location_state: row.locationState,
    location_sublocation: row.locationSublocation,
    interests: (row.interests as string[] | null) ?? null,
    onboarding_completed: row.onboardingCompleted,
    created_at: toIso(row.createdAt) ?? nowIso(),
    updated_at: toIso(row.updatedAt) ?? nowIso(),
  };
}

async function loadRoleNames(userId: number): Promise<string[]> {
  const rows = await db
    .select({ name: roles.name })
    .from(modelHasRoles)
    .innerJoin(roles, eq(modelHasRoles.roleId, roles.id))
    .where(
      and(
        eq(modelHasRoles.modelId, userId),
        eq(modelHasRoles.modelType, MODEL_TYPE),
      ),
    );
  return rows.map((r) => r.name);
}

/**
 * UserStore over `users` + `model_has_roles` (roles read on every lookup;
 * default `buyer` role assigned on create — Laravel assignRoleSafely parity).
 */
export function createDbUserStore(): UserStore {
  async function lookupById(id: number): Promise<AuthUser | null> {
    const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
    if (!row) return null;
    return rowToAuthUser(row, await loadRoleNames(row.id));
  }

  return {
    async findById(id: string): Promise<AuthUser | null> {
      const numeric = Number(id);
      if (!Number.isSafeInteger(numeric)) return null;
      return lookupById(numeric);
    },

    async findByEmail(email: string): Promise<AuthUser | null> {
      const normalized = normalizeEmail(email);
      const [row] = await db
        .select()
        .from(users)
        .where(eq(users.email, normalized))
        .limit(1);
      if (!row) return null;
      return rowToAuthUser(row, await loadRoleNames(row.id));
    },

    async findByPhone(phone: string): Promise<AuthUser | null> {
      const normalized = normalizePhone(phone);
      const [row] = await db
        .select()
        .from(users)
        .where(eq(users.phone, normalized))
        .limit(1);
      if (!row) return null;
      return rowToAuthUser(row, await loadRoleNames(row.id));
    },

    async findByProvider(
      provider: string,
      providerId: string,
    ): Promise<AuthUser | null> {
      const [row] = await db
        .select()
        .from(users)
        .where(
          and(
            eq(users.authProvider, provider as typeof users.$inferSelect.authProvider),
            eq(users.providerId, providerId),
          ),
        )
        .limit(1);
      if (!row) return null;
      return rowToAuthUser(row, await loadRoleNames(row.id));
    },

    async create(input: CreateUserInput): Promise<AuthUser> {
      const [row] = await db
        .insert(users)
        .values({
          name: input.name,
          email: input.email ? normalizeEmail(input.email) : null,
          phone: input.phone ? normalizePhone(input.phone) : null,
          password: input.passwordHash ?? null,
          authProvider: (input.auth_provider ?? "email") as typeof users.$inferInsert.authProvider,
          providerId: input.provider_id ?? null,
        })
        .returning();
      const created = row as typeof users.$inferSelect;

      // Default role: buyer. Best-effort — a missing seed role must not fail
      // registration (the AuthUser still reports roles: ['buyer']).
      try {
        const [role] = await db
          .select({ id: roles.id })
          .from(roles)
          .where(eq(roles.name, "buyer"))
          .limit(1);
        if (role) {
          await db
            .insert(modelHasRoles)
            .values({ roleId: role.id, modelType: MODEL_TYPE, modelId: created.id })
            .onConflictDoNothing();
        }
      } catch (err) {
        console.warn(
          "[db:users] failed to assign default buyer role:",
          (err as Error).message,
        );
      }

      return rowToAuthUser(created, ["buyer"]);
    },

    async update(id: string, patch: Partial<AuthUser>): Promise<AuthUser | null> {
      const numeric = Number(id);
      if (!Number.isSafeInteger(numeric)) return null;

      const set: Partial<typeof users.$inferInsert> = {};
      if (patch.name !== undefined) set.name = patch.name;
      if ("email" in patch) set.email = patch.email == null ? null : normalizeEmail(patch.email);
      if ("phone" in patch) set.phone = patch.phone == null ? null : normalizePhone(patch.phone);
      if ("passwordHash" in patch) set.password = patch.passwordHash;
      if ("whatsapp_number" in patch) set.whatsappNumber = patch.whatsapp_number;
      if ("location_state" in patch) set.locationState = patch.location_state;
      if ("location_sublocation" in patch) set.locationSublocation = patch.location_sublocation;
      if ("interests" in patch) set.interests = patch.interests as never;
      if ("onboarding_completed" in patch) set.onboardingCompleted = patch.onboarding_completed;
      if ("email_verified_at" in patch) set.emailVerifiedAt = toDate(patch.email_verified_at);
      if ("phone_verified_at" in patch) set.phoneVerifiedAt = toDate(patch.phone_verified_at);
      if ("is_suspended" in patch) set.isSuspended = patch.is_suspended;
      if ("auth_provider" in patch) {
        set.authProvider = patch.auth_provider as typeof users.$inferInsert.authProvider;
      }
      if ("provider_id" in patch) set.providerId = patch.provider_id;

      if (Object.keys(set).length === 0) return lookupById(numeric);

      const [row] = await db
        .update(users)
        .set(set)
        .where(eq(users.id, numeric))
        .returning();
      if (!row) return null;
      return rowToAuthUser(row, await loadRoleNames(row.id));
    },
  };
}

// ── OTP (otp_codes) ─────────────────────────────────────────────────────────

export interface DbOtpStoreOptions {
  ttlMs?: number;
  maxAttempts?: number;
}

/**
 * Same public surface as MemoryOtpStore (issue/verify/clear), persisting to
 * `otp_codes`. Semantics match the memory store: previous unused code for an
 * identifier+type is invalidated on issue; verify throws OTP_NOT_FOUND /
 * EXPIRED / LOCKED / INVALID in the same order; success consumes the code
 * (single-use, via used_at).
 *
 * NOTE: `otp_codes.code` is varchar(10) per the migration, so the plain
 * 6-digit code is stored (Laravel TermiiService parity), not the SHA-256 hash
 * the in-memory store keeps.
 */
export function createDbOtpStore(options: DbOtpStoreOptions = {}) {
  const ttlMs = options.ttlMs ?? OTP_TTL_MS;
  const maxAttempts = options.maxAttempts ?? OTP_MAX_ATTEMPTS;

  return {
    async issue(
      identifier: string,
      type: OtpType,
    ): Promise<{ code: string; expiresAt: number }> {
      const code = generateOtpCode();
      const expiresAt = Date.now() + ttlMs;

      // Invalidate any previous unused code for this identifier + type.
      await db
        .delete(otpCodes)
        .where(
          and(
            eq(otpCodes.identifier, identifier),
            eq(otpCodes.type, type),
            isNull(otpCodes.usedAt),
          ),
        );

      await db.insert(otpCodes).values({
        identifier,
        code,
        type,
        expiresAt: new Date(expiresAt),
        attempts: 0,
      });
      return { code, expiresAt };
    },

    async verify(
      identifier: string,
      code: string,
      type: OtpType,
      now: number = Date.now(),
    ): Promise<void> {
      const [row] = await db
        .select()
        .from(otpCodes)
        .where(
          and(
            eq(otpCodes.identifier, identifier),
            eq(otpCodes.type, type),
            isNull(otpCodes.usedAt),
          ),
        )
        .orderBy(desc(otpCodes.id))
        .limit(1);

      if (!row) {
        throw new OtpError("NOT_FOUND", "No OTP found. Please request a new one.");
      }

      if (row.expiresAt.getTime() <= now) {
        await db.delete(otpCodes).where(eq(otpCodes.id, row.id));
        throw new OtpError("EXPIRED", "OTP has expired. Please request a new one.");
      }

      if (row.attempts >= maxAttempts) {
        throw new OtpError(
          "LOCKED",
          "Too many incorrect attempts. Please request a new OTP.",
        );
      }

      if (row.code !== code) {
        const next = row.attempts + 1;
        await db
          .update(otpCodes)
          .set({ attempts: next })
          .where(eq(otpCodes.id, row.id));
        throw new OtpError(
          "INVALID",
          `Invalid OTP. ${maxAttempts - next} attempt(s) remaining.`,
          maxAttempts - next,
        );
      }

      // Single-use: consume on success.
      await db
        .update(otpCodes)
        .set({ usedAt: new Date(now) })
        .where(eq(otpCodes.id, row.id));
    },

    /** No-op for parity: DB rows persist across requests (tests use memory). */
    clear(): void {},
  };
}

export type DbOtpStore = ReturnType<typeof createDbOtpStore>;

// ── KYC (kyc_profiles) ──────────────────────────────────────────────────────

type KycRow = typeof kycProfiles.$inferSelect;

const PATH_SLOTS: Array<{ name: string; kind: KycDocument["kind"]; field: keyof Pick<KycRow, "ninFrontPath" | "ninBackPath" | "selfiePath" | "cacCertificatePath" | "smedanCertificatePath"> }> = [
  { name: "nin_front", kind: "identity", field: "ninFrontPath" },
  { name: "nin_back", kind: "identity", field: "ninBackPath" },
  { name: "selfie", kind: "identity", field: "selfiePath" },
  { name: "cac_certificate", kind: "business", field: "cacCertificatePath" },
  { name: "smedan_certificate", kind: "business", field: "smedanCertificatePath" },
];

const FIELD_COLUMNS: Array<{ key: string; field: keyof Pick<KycRow, "ninNumber" | "businessName" | "businessType" | "rcNumber" | "tinNumber" | "businessAddress" | "businessPhone" | "businessEmail"> }> = [
  { key: "nin_number", field: "ninNumber" },
  { key: "business_name", field: "businessName" },
  { key: "business_type", field: "businessType" },
  { key: "rc_number", field: "rcNumber" },
  { key: "tin_number", field: "tinNumber" },
  { key: "business_address", field: "businessAddress" },
  { key: "business_phone", field: "businessPhone" },
  { key: "business_email", field: "businessEmail" },
];

function rowToKycRecord(row: KycRow): KycRecord {
  const extra = (row.storeCategories as Record<string, unknown> | null)?.[
    KYC_EXTRA_KEY
  ] as
    | { documents?: KycDocument[]; fields?: Record<string, string | string[] | null> }
    | undefined;

  // Documents: prefer the full-fidelity payload, else rebuild from path columns.
  let documents: KycDocument[] = extra?.documents ?? [];
  if (documents.length === 0) {
    documents = PATH_SLOTS.flatMap((slot) => {
      const url = row[slot.field];
      return url ? [{ name: slot.name, url, kind: slot.kind }] : [];
    });
  }

  // Fields: prefer the payload, else rebuild from the typed columns.
  let fields: Record<string, string | string[] | null> = extra?.fields ?? {};
  if (Object.keys(fields).length === 0) {
    fields = {};
    for (const { key, field } of FIELD_COLUMNS) {
      const value = row[field];
      if (value != null) fields[key] = value;
    }
  }

  return {
    userId: String(row.userId),
    tier: (row.tier === 2 ? 2 : 1) as 1 | 2,
    status: (row.status ?? "pending") as KycStatus,
    rejection_reason: row.rejectionReason,
    documents,
    fields,
    submitted_at: toIso(row.submittedAt) ?? toIso(row.createdAt) ?? nowIso(),
    reviewed_at: toIso(row.reviewedAt),
  };
}

function kycValues(record: KycRecord) {
  const docUrl = (name: string): string | null =>
    record.documents.find((d) => d.name === name)?.url ?? null;
  const fieldStr = (key: string): string | null => {
    const value = record.fields[key];
    return value == null || Array.isArray(value) ? null : value;
  };

  const payload: Record<string, unknown> = {
    [KYC_EXTRA_KEY]: {
      documents: record.documents,
      fields: record.fields,
    },
  };

  return {
    userId: Number(record.userId),
    tier: record.tier,
    status: record.status,
    rejectionReason: record.rejection_reason,
    ninNumber: fieldStr("nin_number"),
    ninFrontPath: docUrl("nin_front"),
    ninBackPath: docUrl("nin_back"),
    selfiePath: docUrl("selfie"),
    cacCertificatePath: docUrl("cac_certificate"),
    smedanCertificatePath: docUrl("smedan_certificate"),
    businessName: fieldStr("business_name"),
    businessType: fieldStr("business_type"),
    rcNumber: fieldStr("rc_number"),
    tinNumber: fieldStr("tin_number"),
    businessAddress: fieldStr("business_address"),
    businessPhone: fieldStr("business_phone"),
    businessEmail: fieldStr("business_email"),
    storeCategories: payload,
    submittedAt: toDate(record.submitted_at) ?? new Date(),
    reviewedAt: toDate(record.reviewed_at),
  } satisfies typeof kycProfiles.$inferInsert;
}

/**
 * MemoryKycStore interface backed by `kyc_profiles`, keyed by the public user
 * id (String(users.id)). Full documents[]/fields{} fidelity rides in the
 * reserved `__dn` payload inside store_categories jsonb; known values are
 * mirrored into the typed columns for DB readability.
 */
export function createDbKycStore() {
  return {
    async get(userId: string): Promise<KycRecord | null> {
      const numeric = Number(userId);
      if (!Number.isSafeInteger(numeric)) return null;
      const [row] = await db
        .select()
        .from(kycProfiles)
        .where(eq(kycProfiles.userId, numeric))
        .limit(1);
      return row ? rowToKycRecord(row) : null;
    },

    async upsert(record: KycRecord): Promise<KycRecord> {
      const values = kycValues(record);
      const { userId: _userId, ...set } = values;
      await db
        .insert(kycProfiles)
        .values(values)
        .onConflictDoUpdate({
          target: kycProfiles.userId,
          set: { ...set, updatedAt: new Date() },
        });
      return record;
    },

    /** Admin/test helper: force a review outcome. */
    async setStatus(
      userId: string,
      status: KycStatus,
      reason?: string | null,
    ): Promise<KycRecord | null> {
      const numeric = Number(userId);
      if (!Number.isSafeInteger(numeric)) return null;
      const [row] = await db
        .update(kycProfiles)
        .set({
          status,
          rejectionReason: status === "rejected" ? (reason ?? null) : null,
          reviewedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(kycProfiles.userId, numeric))
        .returning();
      return row ? rowToKycRecord(row) : null;
    },

    /** Approved tier, or 0 when there is no approved KYC. */
    async approvedTier(userId: string): Promise<number> {
      const numeric = Number(userId);
      if (!Number.isSafeInteger(numeric)) return 0;
      const [row] = await db
        .select({ tier: kycProfiles.tier, status: kycProfiles.status })
        .from(kycProfiles)
        .where(eq(kycProfiles.userId, numeric))
        .limit(1);
      if (!row || row.status !== "approved") return 0;
      return row.tier;
    },

    /** No-op for parity: DB rows persist across requests (tests use memory). */
    clear(): void {},
  };
}

export type DbKycStore = ReturnType<typeof createDbKycStore>;

// ── Seller applications ─────────────────────────────────────────────────────

/**
 * SellerApplication store backed by `seller_applications`. The insert needs
 * the user's kyc_profiles.id (NOT NULL FK) — the KYC guard guarantees an
 * approved profile exists before create() is reached.
 */
export function createDbSellerApplicationStore() {
  async function rowToSeller(
    row: typeof sellerApplications.$inferSelect,
  ): Promise<SellerApplication> {
    return {
      id: String(row.id),
      userId: String(row.userId),
      status: row.status,
      store_name: row.storeName,
      store_description: row.storeDescription,
      store_phone: row.storePhone,
      store_email: row.storeEmail,
      store_state: row.storeState,
      store_sublocation: row.storeSublocation,
      store_market: row.storeMarket,
      store_categories: (row.storeCategories as string[]) ?? [],
      store_address: row.storeAddress,
      store_lat: row.storeLat != null ? Number(row.storeLat) : null,
      store_lng: row.storeLng != null ? Number(row.storeLng) : null,
      store_logo_url: row.storeLogoPath,
      declined_reason: row.declinedReason,
      reviewed_at: toIso(row.reviewedAt),
      created_at: toIso(row.createdAt) ?? nowIso(),
    };
  }

  return {
    async create(
      data: Omit<SellerApplication, "id" | "created_at">,
    ): Promise<SellerApplication> {
      const userId = Number(data.userId);
      const [kyc] = await db
        .select({ id: kycProfiles.id })
        .from(kycProfiles)
        .where(eq(kycProfiles.userId, userId))
        .limit(1);
      if (!kyc) {
        throw new Error(
          `No KYC profile found for user ${data.userId}; cannot create seller application.`,
        );
      }
      const [row] = await db
        .insert(sellerApplications)
        .values({
          userId,
          kycProfileId: kyc.id,
          storeName: data.store_name,
          storeDescription: data.store_description,
          storePhone: data.store_phone,
          storeEmail: data.store_email,
          storeState: data.store_state,
          storeSublocation: data.store_sublocation,
          storeMarket: data.store_market,
          storeCategories: data.store_categories,
          storeLogoPath: data.store_logo_url,
          storeAddress: data.store_address,
          storeLat: data.store_lat != null ? String(data.store_lat) : null,
          storeLng: data.store_lng != null ? String(data.store_lng) : null,
          status: data.status,
          declinedReason: data.declined_reason,
          reviewedAt: toDate(data.reviewed_at),
        })
        .returning();
      if (!row) throw new Error("seller application insert returned no row");
      return rowToSeller(row);
    },

    async latestByUser(userId: string): Promise<SellerApplication | null> {
      const numeric = Number(userId);
      if (!Number.isSafeInteger(numeric)) return null;
      const [row] = await db
        .select()
        .from(sellerApplications)
        .where(eq(sellerApplications.userId, numeric))
        .orderBy(desc(sellerApplications.id))
        .limit(1);
      return row ? rowToSeller(row) : null;
    },

    async pendingByUser(userId: string): Promise<SellerApplication | null> {
      const numeric = Number(userId);
      if (!Number.isSafeInteger(numeric)) return null;
      const [row] = await db
        .select()
        .from(sellerApplications)
        .where(
          and(
            eq(sellerApplications.userId, numeric),
            eq(sellerApplications.status, "pending"),
          ),
        )
        .orderBy(desc(sellerApplications.id))
        .limit(1);
      return row ? rowToSeller(row) : null;
    },

    /** No-op for parity: DB rows persist across requests (tests use memory). */
    clear(): void {},
  };
}

export type DbSellerApplicationStore = ReturnType<typeof createDbSellerApplicationStore>;

// ── Provider applications ───────────────────────────────────────────────────

export function createDbProviderApplicationStore() {
  async function rowToProvider(
    row: typeof providerApplications.$inferSelect,
  ): Promise<ProviderApplication> {
    return {
      id: String(row.id),
      userId: String(row.userId),
      status: row.status,
      full_name: row.fullName,
      business_name: row.businessName,
      bio: row.bio,
      service_categories: (row.serviceCategories as string[]) ?? [],
      years_experience: row.yearsExperience,
      price_range: row.priceRange,
      response_time: row.responseTime,
      availability: row.availability,
      location_state: row.locationState,
      location_sublocation: row.locationSublocation,
      location_lat: row.locationLat != null ? Number(row.locationLat) : null,
      location_lng: row.locationLng != null ? Number(row.locationLng) : null,
      contact_phone: row.contactPhone,
      contact_whatsapp: row.contactWhatsapp,
      photo_url: row.photoPath,
      declined_reason: row.declinedReason,
      reviewed_at: toIso(row.reviewedAt),
      created_at: toIso(row.createdAt) ?? nowIso(),
    };
  }

  return {
    async create(
      data: Omit<ProviderApplication, "id" | "created_at">,
    ): Promise<ProviderApplication> {
      const userId = Number(data.userId);
      const [kyc] = await db
        .select({ id: kycProfiles.id })
        .from(kycProfiles)
        .where(eq(kycProfiles.userId, userId))
        .limit(1);
      if (!kyc) {
        throw new Error(
          `No KYC profile found for user ${data.userId}; cannot create provider application.`,
        );
      }
      const [row] = await db
        .insert(providerApplications)
        .values({
          userId,
          kycProfileId: kyc.id,
          fullName: data.full_name,
          businessName: data.business_name,
          bio: data.bio,
          serviceCategories: data.service_categories,
          yearsExperience: data.years_experience,
          priceRange: data.price_range,
          responseTime: data.response_time,
          availability: data.availability,
          locationState: data.location_state,
          locationSublocation: data.location_sublocation,
          locationLat: data.location_lat != null ? String(data.location_lat) : null,
          locationLng: data.location_lng != null ? String(data.location_lng) : null,
          contactPhone: data.contact_phone,
          contactWhatsapp: data.contact_whatsapp,
          photoPath: data.photo_url,
          status: data.status,
          declinedReason: data.declined_reason,
          reviewedAt: toDate(data.reviewed_at),
        })
        .returning();
      if (!row) throw new Error("provider application insert returned no row");
      return rowToProvider(row);
    },

    async latestByUser(userId: string): Promise<ProviderApplication | null> {
      const numeric = Number(userId);
      if (!Number.isSafeInteger(numeric)) return null;
      const [row] = await db
        .select()
        .from(providerApplications)
        .where(eq(providerApplications.userId, numeric))
        .orderBy(desc(providerApplications.id))
        .limit(1);
      return row ? rowToProvider(row) : null;
    },

    async pendingByUser(userId: string): Promise<ProviderApplication | null> {
      const numeric = Number(userId);
      if (!Number.isSafeInteger(numeric)) return null;
      const [row] = await db
        .select()
        .from(providerApplications)
        .where(
          and(
            eq(providerApplications.userId, numeric),
            eq(providerApplications.status, "pending"),
          ),
        )
        .orderBy(desc(providerApplications.id))
        .limit(1);
      return row ? rowToProvider(row) : null;
    },

    /** No-op for parity: DB rows persist across requests (tests use memory). */
    clear(): void {},
  };
}

export type DbProviderApplicationStore = ReturnType<typeof createDbProviderApplicationStore>;

// ── Boot-time auto-detect (DATABASE_URL reachable -> DB-backed defaults) ────

export interface DbStores {
  users: UserStore;
  otp: DbOtpStore;
  kyc: DbKycStore;
  sellers: DbSellerApplicationStore;
  providers: DbProviderApplicationStore;
}

const PROBE_TIMEOUT_MS = 3000;

let probePromise: Promise<boolean> | null = null;
let cachedDbStores: DbStores | null = null;
let dbReady = false;
let probeLogged = false;

function probe(): Promise<boolean> {
  if (!probePromise) {
    probePromise = (async () => {
      try {
        const ping = sqlClient`select 1`;
        // No-op rejection handler so an abandoned ping (after the timeout
        // wins) can never surface as an unhandled rejection. `ping` itself
        // still rejects for the race below — `.catch()` returns a fresh
        // promise, so the original rejection propagates to Promise.race().
        ping.catch(() => null);
        await Promise.race([
          ping,
          new Promise<void>((_, reject) =>
            setTimeout(() => reject(new Error("connection timed out")), PROBE_TIMEOUT_MS),
          ),
        ]);
        dbReady = true;
        return true;
      } catch (err) {
        if (!probeLogged) {
          probeLogged = true;
          console.warn(
            `[db] Postgres at ${env.DATABASE_URL} unreachable (${(err as Error).message}). ` +
              "Auth/KYC/applications fall back to in-memory stores.",
          );
        }
        return false;
      }
    })();
  }
  return probePromise;
}

/** True once the boot probe has confirmed DATABASE_URL is reachable. */
export function dbModeActive(): boolean {
  return dbReady;
}

/**
 * The shared DB store set, or null while the DB is unreachable. All three
 * modules resolve their defaults from this one object so the auth, kyc and
 * applications plugins share the same user store (JWT `sub` resolution must
 * see the same rows the auth routes write).
 */
export function getDbStores(): DbStores | null {
  if (!dbReady) return null;
  if (!cachedDbStores) {
    cachedDbStores = {
      users: createDbUserStore(),
      otp: createDbOtpStore(),
      kyc: createDbKycStore(),
      sellers: createDbSellerApplicationStore(),
      providers: createDbProviderApplicationStore(),
    };
  }
  return cachedDbStores;
}

// Top-level await: run the probe before any plugin factory constructs its
// defaults, so `createAuthPlugin()` / `createKycPlugin()` /
// `createApplicationsPlugin()` called at module load pick the DB stores when
// the database is reachable (fast locally; bounded by PROBE_TIMEOUT_MS if not).
await probe();