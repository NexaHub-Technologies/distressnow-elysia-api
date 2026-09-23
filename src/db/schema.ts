import {
  bigint,
  bigserial,
  boolean,
  date,
  decimal,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

/**
 * COMPLETE drizzle schema — mirrors every Laravel migration in
 * DistressNowApi/database/migrations/*.php.
 *
 * Conventions carried over from Laravel:
 * - `$table->id()`            -> bigserial PK (integer PK + separate `uuid`
 *                               column where the migration defines one;
 *                               route binding uses the `uuid` column).
 * - `$table->timestamps()`    -> timestamptz created_at / updated_at.
 * - `$table->softDeletes()`   -> nullable timestamptz deleted_at.
 * - `$table->enum(...)`       -> pgEnum (shared only when values match).
 * - `$table->string(...)`     -> text/varchar, `$table->json()` -> jsonb.
 */

// ─── Shared column helpers ────────────────────────────────────────────────

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
};

const softDelete = {
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
};

// ─── Enums ────────────────────────────────────────────────────────────────

export const authProviderEnum = pgEnum("auth_provider", [
  "email",
  "phone",
  "google",
  "apple",
]);

export const presenceStatusEnum = pgEnum("presence_status", [
  "online",
  "away",
  "offline",
]);

export const kycStatusEnum = pgEnum("kyc_status", [
  "pending",
  "approved",
  "rejected",
]);

export const applicationStatusEnum = pgEnum("application_status", [
  "pending",
  "approved",
  "declined",
]);

export const otpTypeEnum = pgEnum("otp_type", [
  "phone_signup",
  "email_signup",
  "phone_reset",
  "email_reset",
]);

export const ticketCategoryEnum = pgEnum("ticket_category", [
  "general_inquiry",
  "report_issue",
  "account_services",
  "listing_issues",
  "verification_issues",
  "billing",
  "other",
]);

export const ticketPriorityEnum = pgEnum("ticket_priority", [
  "low",
  "normal",
  "high",
  "urgent",
]);

export const ticketStatusEnum = pgEnum("ticket_status", [
  "open",
  "pending",
  "resolved",
  "closed",
]);

export const ticketPlatformEnum = pgEnum("ticket_platform", [
  "mobile",
  "web",
  "unknown",
]);

export const senderTypeEnum = pgEnum("sender_type", ["user", "support", "system"]);

export const devicePlatformEnum = pgEnum("device_platform", [
  "ios",
  "android",
  "web",
]);

export const broadcastAudienceEnum = pgEnum("broadcast_audience", [
  "all",
  "role",
  "state",
  "users",
]);

export const broadcastStatusEnum = pgEnum("broadcast_status", [
  "queued",
  "sending",
  "sent",
  "failed",
]);

/** provider_applications.location availability (5 values). */
export const providerApplicationAvailabilityEnum = pgEnum(
  "provider_application_availability",
  ["immediate", "scheduled", "busy", "weekends", "unavailable"],
);

/** service_providers availability (2 values — distinct pg type). */
export const providerAvailabilityEnum = pgEnum("provider_availability", [
  "immediate",
  "scheduled",
]);

export const chatMessageTypeEnum = pgEnum("chat_message_type", [
  "text",
  "image",
  "file",
]);

// ─── users (+ presence heartbeat, suspension) ─────────────────────────────

export const users = pgTable(
  "users",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    name: text("name").notNull(),
    email: text("email").unique(),
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
    phone: varchar("phone", { length: 20 }).unique(),
    phoneVerifiedAt: timestamp("phone_verified_at", { withTimezone: true }),
    whatsappNumber: varchar("whatsapp_number", { length: 20 }),
    password: text("password"),
    avatarPath: text("avatar_path"),
    authProvider: authProviderEnum("auth_provider").default("email").notNull(),
    providerId: text("provider_id"),
    onboardingCompleted: boolean("onboarding_completed").default(false).notNull(),
    locationState: text("location_state"),
    locationSublocation: text("location_sublocation"),
    interests: jsonb("interests"),
    // Suspension (EnsureNotSuspended reads is_suspended)
    isSuspended: boolean("is_suspended").default(false).notNull(),
    suspensionReason: text("suspension_reason"),
    suspendedAt: timestamp("suspended_at", { withTimezone: true }),
    suspendedBy: bigint("suspended_by", { mode: "number" }),
    // Chat presence heartbeat (presence_status + last_seen_at + typing_*)
    presenceStatus: presenceStatusEnum("presence_status")
      .default("offline")
      .notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    typingInConversation: varchar("typing_in_conversation", { length: 191 }),
    typingAt: timestamp("typing_at", { withTimezone: true }),
    rememberToken: varchar("remember_token", { length: 100 }),
    profileViewsCount: bigint("profile_views_count", { mode: "number" })
      .default(0)
      .notNull(),
    notificationSettings: jsonb("notification_settings"),
    ...timestamps,
  },
  (t) => [index("users_last_seen_at_idx").on(t.lastSeenAt)],
);

export const passwordResetTokens = pgTable("password_reset_tokens", {
  email: text("email").primaryKey(),
  token: text("token").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }),
});

// ─── Roles & permissions (spatie/laravel-permission shape) ────────────────

export const roles = pgTable(
  "roles",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    name: text("name").notNull(),
    guardName: text("guard_name").notNull(),
    ...timestamps,
  },
  (t) => [unique("roles_name_guard_unique").on(t.name, t.guardName)],
);

export const permissions = pgTable(
  "permissions",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    name: text("name").notNull(),
    guardName: text("guard_name").notNull(),
    ...timestamps,
  },
  (t) => [unique("permissions_name_guard_unique").on(t.name, t.guardName)],
);

export const modelHasRoles = pgTable(
  "model_has_roles",
  {
    roleId: bigint("role_id", { mode: "number" })
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    modelType: text("model_type").notNull(),
    modelId: bigint("model_id", { mode: "number" }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.roleId, t.modelId, t.modelType] }),
    index("model_has_roles_model_idx").on(t.modelId, t.modelType),
  ],
);

export const modelHasPermissions = pgTable(
  "model_has_permissions",
  {
    permissionId: bigint("permission_id", { mode: "number" })
      .notNull()
      .references(() => permissions.id, { onDelete: "cascade" }),
    modelType: text("model_type").notNull(),
    modelId: bigint("model_id", { mode: "number" }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.permissionId, t.modelId, t.modelType] }),
    index("model_has_permissions_model_idx").on(t.modelId, t.modelType),
  ],
);

export const roleHasPermissions = pgTable(
  "role_has_permissions",
  {
    permissionId: bigint("permission_id", { mode: "number" })
      .notNull()
      .references(() => permissions.id, { onDelete: "cascade" }),
    roleId: bigint("role_id", { mode: "number" })
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.permissionId, t.roleId] })],
);

// ─── kyc_profiles ─────────────────────────────────────────────────────────

export const kycProfiles = pgTable("kyc_profiles", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  userId: bigint("user_id", { mode: "number" })
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: "cascade" }),
  /** 0 = none, 1 = identity (provider), 2 = business (seller) */
  tier: smallint("tier").default(0).notNull(),
  status: kycStatusEnum("status"),
  rejectionReason: text("rejection_reason"),
  // Tier 1: identity
  ninNumber: text("nin_number"),
  ninFrontPath: text("nin_front_path"),
  ninBackPath: text("nin_back_path"),
  selfiePath: text("selfie_path"),
  // Tier 2: business
  businessName: text("business_name"),
  businessType: text("business_type"),
  rcNumber: text("rc_number"),
  tinNumber: text("tin_number"),
  businessAddress: text("business_address"),
  businessPhone: varchar("business_phone", { length: 20 }),
  businessEmail: text("business_email"),
  alternateBusinessPhone: varchar("alternate_business_phone", { length: 20 }),
  storeCategories: jsonb("store_categories"),
  cacCertificatePath: text("cac_certificate_path"),
  smedanCertificatePath: text("smedan_certificate_path"),
  // Review
  reviewedBy: bigint("reviewed_by", { mode: "number" }).references(() => users.id, {
    onDelete: "set null",
  }),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  submittedAt: timestamp("submitted_at", { withTimezone: true }),
  ...timestamps,
});

// ─── seller_applications / provider_applications ──────────────────────────

export const sellerApplications = pgTable(
  "seller_applications",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    userId: bigint("user_id", { mode: "number" })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kycProfileId: bigint("kyc_profile_id", { mode: "number" })
      .notNull()
      .references(() => kycProfiles.id, { onDelete: "restrict" }),
    storeName: text("store_name").notNull(),
    storeDescription: text("store_description"),
    storePhone: varchar("store_phone", { length: 20 }).notNull(),
    storeEmail: text("store_email").notNull(),
    storeState: text("store_state").notNull(),
    storeSublocation: text("store_sublocation").notNull(),
    storeMarket: text("store_market").notNull(),
    storeCategories: jsonb("store_categories").notNull(),
    storeLogoPath: text("store_logo_path"),
    storeAddress: text("store_address"),
    storeLat: decimal("store_lat", { precision: 10, scale: 7 }),
    storeLng: decimal("store_lng", { precision: 10, scale: 7 }),
    status: applicationStatusEnum("status").default("pending").notNull(),
    declinedReason: text("declined_reason"),
    reviewedBy: bigint("reviewed_by", { mode: "number" }).references(
      () => users.id,
      { onDelete: "set null" },
    ),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index("seller_applications_user_status_idx").on(t.userId, t.status)],
);

export const providerApplications = pgTable(
  "provider_applications",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    userId: bigint("user_id", { mode: "number" })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kycProfileId: bigint("kyc_profile_id", { mode: "number" })
      .notNull()
      .references(() => kycProfiles.id, { onDelete: "restrict" }),
    fullName: text("full_name").notNull(),
    businessName: text("business_name"),
    bio: text("bio"),
    serviceCategories: jsonb("service_categories").notNull(),
    yearsExperience: smallint("years_experience").default(0).notNull(),
    priceRange: text("price_range"),
    responseTime: text("response_time"),
    availability: providerApplicationAvailabilityEnum("availability")
      .default("immediate")
      .notNull(),
    locationState: text("location_state").notNull(),
    locationSublocation: text("location_sublocation").notNull(),
    locationLat: decimal("location_lat", { precision: 10, scale: 7 }),
    locationLng: decimal("location_lng", { precision: 10, scale: 7 }),
    contactPhone: varchar("contact_phone", { length: 20 }).notNull(),
    contactWhatsapp: varchar("contact_whatsapp", { length: 20 }),
    photoPath: text("photo_path"),
    status: applicationStatusEnum("status").default("pending").notNull(),
    declinedReason: text("declined_reason"),
    reviewedBy: bigint("reviewed_by", { mode: "number" }).references(
      () => users.id,
      { onDelete: "set null" },
    ),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index("provider_applications_user_status_idx").on(t.userId, t.status)],
);

// ─── otp_codes / admin_logs ───────────────────────────────────────────────

export const otpCodes = pgTable(
  "otp_codes",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    identifier: text("identifier").notNull(),
    code: varchar("code", { length: 10 }).notNull(),
    type: otpTypeEnum("type").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    attempts: smallint("attempts").default(0).notNull(),
    ...timestamps,
  },
  (t) => [index("otp_codes_identifier_type_idx").on(t.identifier, t.type)],
);

export const adminLogs = pgTable(
  "admin_logs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    adminId: bigint("admin_id", { mode: "number" })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: bigint("target_id", { mode: "number" }),
    details: jsonb("details"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("admin_logs_admin_created_idx").on(t.adminId, t.createdAt),
    index("admin_logs_target_idx").on(t.targetType, t.targetId),
  ],
);

// ─── support_tickets / support_messages ───────────────────────────────────

export const supportTickets = pgTable(
  "support_tickets",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    ticketNumber: varchar("ticket_number", { length: 20 }).notNull().unique(),
    userId: bigint("user_id", { mode: "number" })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    subject: text("subject").notNull(),
    category: ticketCategoryEnum("category").default("general_inquiry").notNull(),
    priority: ticketPriorityEnum("priority").default("normal").notNull(),
    status: ticketStatusEnum("status").default("open").notNull(),
    platform: ticketPlatformEnum("platform").default("unknown").notNull(),
    lastMessage: text("last_message"),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
    assignedTo: bigint("assigned_to", { mode: "number" }).references(() => users.id, {
      onDelete: "set null",
    }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index("support_tickets_user_status_idx").on(t.userId, t.status),
    index("support_tickets_status_priority_idx").on(t.status, t.priority),
    index("support_tickets_last_message_at_idx").on(t.lastMessageAt),
  ],
);

export const supportMessages = pgTable(
  "support_messages",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    supportTicketId: bigint("support_ticket_id", { mode: "number" })
      .notNull()
      .references(() => supportTickets.id, { onDelete: "cascade" }),
    userId: bigint("user_id", { mode: "number" }).references(() => users.id, {
      onDelete: "set null",
    }),
    senderType: senderTypeEnum("sender_type").default("user").notNull(),
    message: text("message").notNull(),
    attachments: jsonb("attachments"),
    readAt: timestamp("read_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index("support_messages_ticket_created_idx").on(t.supportTicketId, t.createdAt)],
);

// ─── notifications / device_tokens / notification_broadcasts ──────────────

export const notifications = pgTable(
  "notifications",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    userId: bigint("user_id", { mode: "number" })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: varchar("type", { length: 60 }).notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    data: jsonb("data"),
    readAt: timestamp("read_at", { withTimezone: true }),
    pushedAt: timestamp("pushed_at", { withTimezone: true }),
    emailedAt: timestamp("emailed_at", { withTimezone: true }),
    smsedAt: timestamp("smsed_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index("notifications_user_read_idx").on(t.userId, t.readAt),
    index("notifications_user_created_idx").on(t.userId, t.createdAt),
  ],
);

export const deviceTokens = pgTable(
  "device_tokens",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    userId: bigint("user_id", { mode: "number" })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    token: text("token").notNull().unique(),
    platform: devicePlatformEnum("platform").notNull(),
    deviceName: text("device_name"),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index("device_tokens_user_platform_idx").on(t.userId, t.platform)],
);

export const notificationBroadcasts = pgTable(
  "notification_broadcasts",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    adminId: bigint("admin_id", { mode: "number" })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    audience: broadcastAudienceEnum("audience").default("all").notNull(),
    audienceRole: text("audience_role"),
    audienceState: text("audience_state"),
    audienceUserIds: jsonb("audience_user_ids"),
    type: varchar("type", { length: 60 }).default("announcement").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    data: jsonb("data"),
    channels: jsonb("channels"),
    status: broadcastStatusEnum("status").default("queued").notNull(),
    recipientCount: integer("recipient_count").default(0).notNull(),
    sentCount: integer("sent_count").default(0).notNull(),
    failureReason: text("failure_reason"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index("notification_broadcasts_admin_created_idx").on(t.adminId, t.createdAt),
    index("notification_broadcasts_status_created_idx").on(t.status, t.createdAt),
  ],
);

// ─── categories / subcategories ───────────────────────────────────────────

export const categories = pgTable("categories", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  uuid: uuid("uuid").notNull().unique().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  icon: text("icon"),
  imagePath: text("image_path"),
  sortOrder: integer("sort_order").default(0).notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  ...timestamps,
});

export const subcategories = pgTable(
  "subcategories",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    uuid: uuid("uuid").notNull().unique().defaultRandom(),
    categoryId: bigint("category_id", { mode: "number" })
      .notNull()
      .references(() => categories.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    sortOrder: integer("sort_order").default(0).notNull(),
    isActive: boolean("is_active").default(true).notNull(),
    ...timestamps,
  },
  (t) => [unique("subcategories_category_slug_unique").on(t.categoryId, t.slug)],
);

// ─── states / sublocations / markets ──────────────────────────────────────

export const states = pgTable("states", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  uuid: uuid("uuid").notNull().unique().defaultRandom(),
  name: text("name").notNull().unique(),
  slug: text("slug").notNull().unique(),
  code: text("code"),
  isActive: boolean("is_active").default(true).notNull(),
  ...timestamps,
});

export const sublocations = pgTable(
  "sublocations",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    uuid: uuid("uuid").notNull().unique().defaultRandom(),
    stateId: bigint("state_id", { mode: "number" })
      .notNull()
      .references(() => states.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    isActive: boolean("is_active").default(true).notNull(),
    ...timestamps,
  },
  (t) => [unique("sublocations_state_slug_unique").on(t.stateId, t.slug)],
);

export const markets = pgTable(
  "markets",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    uuid: uuid("uuid").notNull().unique().defaultRandom(),
    stateId: bigint("state_id", { mode: "number" })
      .notNull()
      .references(() => states.id, { onDelete: "cascade" }),
    sublocationId: bigint("sublocation_id", { mode: "number" }).references(
      () => sublocations.id,
      { onDelete: "set null" },
    ),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    address: text("address"),
    latitude: decimal("latitude", { precision: 10, scale: 7 }),
    longitude: decimal("longitude", { precision: 10, scale: 7 }),
    isActive: boolean("is_active").default(true).notNull(),
    ...timestamps,
  },
  (t) => [unique("markets_state_slug_unique").on(t.stateId, t.slug)],
);

// ─── stores / store_follows ───────────────────────────────────────────────

export const stores = pgTable(
  "stores",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    uuid: uuid("uuid").notNull().unique().defaultRandom(),
    userId: bigint("user_id", { mode: "number" })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),
    description: text("description"),
    logoPath: text("logo_path"),
    bannerPath: text("banner_path"),
    phone: varchar("phone", { length: 20 }),
    email: text("email"),
    whatsappNumber: varchar("whatsapp_number", { length: 20 }),
    stateId: bigint("state_id", { mode: "number" }).references(() => states.id, {
      onDelete: "set null",
    }),
    sublocationId: bigint("sublocation_id", { mode: "number" }).references(
      () => sublocations.id,
      { onDelete: "set null" },
    ),
    marketId: bigint("market_id", { mode: "number" }).references(() => markets.id, {
      onDelete: "set null",
    }),
    address: text("address"),
    latitude: decimal("latitude", { precision: 10, scale: 7 }),
    longitude: decimal("longitude", { precision: 10, scale: 7 }),
    categories: jsonb("categories"),
    socialLinks: jsonb("social_links"),
    openingHours: jsonb("opening_hours"),
    isVerified: boolean("is_verified").default(false).notNull(),
    status: text("status").default("active").notNull(),
    rating: decimal("rating", { precision: 3, scale: 2 }).default("0").notNull(),
    reviewCount: integer("review_count").default(0).notNull(),
    listingsCount: integer("listings_count").default(0).notNull(),
    followersCount: integer("followers_count").default(0).notNull(),
    viewsCount: bigint("views_count", { mode: "number" }).default(0).notNull(),
    isPromoted: boolean("is_promoted").default(false).notNull(),
    promotionType: varchar("promotion_type", { length: 50 }),
    promotedAt: timestamp("promoted_at", { withTimezone: true }),
    promotionExpiry: timestamp("promotion_expiry", { withTimezone: true }),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    lastActiveAt: timestamp("last_active_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index("stores_state_sublocation_idx").on(t.stateId, t.sublocationId),
    index("stores_verified_status_idx").on(t.isVerified, t.status),
  ],
);

export const storeFollows = pgTable(
  "store_follows",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    userId: bigint("user_id", { mode: "number" })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    storeId: bigint("store_id", { mode: "number" })
      .notNull()
      .references(() => stores.id, { onDelete: "cascade" }),
    ...timestamps,
  },
  (t) => [
    unique("store_follows_user_store_unique").on(t.userId, t.storeId),
    index("store_follows_store_idx").on(t.storeId),
  ],
);

// ─── service_providers / contact_updates ──────────────────────────────────

export const serviceProviders = pgTable(
  "service_providers",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    uuid: uuid("uuid").notNull().unique().defaultRandom(),
    userId: bigint("user_id", { mode: "number" })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),
    bio: text("bio"),
    photoPath: text("photo_path"),
    serviceCategories: jsonb("service_categories").notNull(),
    experienceYears: integer("experience_years").default(0).notNull(),
    priceRange: text("price_range"),
    responseTime: text("response_time"),
    availability: providerAvailabilityEnum("availability")
      .default("immediate")
      .notNull(),
    phone: varchar("phone", { length: 20 }),
    whatsapp: varchar("whatsapp", { length: 20 }),
    stateId: bigint("state_id", { mode: "number" }).references(() => states.id, {
      onDelete: "set null",
    }),
    sublocationId: bigint("sublocation_id", { mode: "number" }).references(
      () => sublocations.id,
      { onDelete: "set null" },
    ),
    locationText: text("location_text"),
    latitude: decimal("latitude", { precision: 10, scale: 7 }),
    longitude: decimal("longitude", { precision: 10, scale: 7 }),
    skills: jsonb("skills"),
    isVerified: boolean("is_verified").default(false).notNull(),
    rating: decimal("rating", { precision: 3, scale: 2 }).default("0").notNull(),
    totalReviews: integer("total_reviews").default(0).notNull(),
    completedJobs: integer("completed_jobs").default(0).notNull(),
    totalServices: integer("total_services").default(0).notNull(),
    viewsCount: bigint("views_count", { mode: "number" }).default(0).notNull(),
    ...timestamps,
  },
  (t) => [
    index("service_providers_state_sublocation_idx").on(t.stateId, t.sublocationId),
    index("service_providers_verified_idx").on(t.isVerified),
    index("service_providers_availability_idx").on(t.availability),
  ],
);

export const contactUpdates = pgTable(
  "contact_updates",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    providerId: bigint("provider_id", { mode: "number" })
      .notNull()
      .references(() => serviceProviders.id, { onDelete: "cascade" }),
    requestedBy: bigint("requested_by", { mode: "number" })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    proposedChanges: jsonb("proposed_changes").notNull(),
    status: varchar("status", { length: 20 }).default("pending").notNull(),
    reviewedBy: bigint("reviewed_by", { mode: "number" }).references(
      () => users.id,
      { onDelete: "set null" },
    ),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index("contact_updates_status_created_idx").on(t.status, t.createdAt)],
);

// ─── bookings ─────────────────────────────────────────────────────────────

export const bookings = pgTable(
  "bookings",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    uuid: uuid("uuid").notNull().unique().defaultRandom(),
    userId: bigint("user_id", { mode: "number" })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    providerId: bigint("provider_id", { mode: "number" })
      .notNull()
      .references(() => serviceProviders.id, { onDelete: "cascade" }),
    serviceType: text("service_type").notNull(),
    description: text("description"),
    preferredDate: date("preferred_date"),
    preferredTime: text("preferred_time"),
    locationText: text("location_text"),
    latitude: decimal("latitude", { precision: 10, scale: 7 }),
    longitude: decimal("longitude", { precision: 10, scale: 7 }),
    quotedPrice: decimal("quoted_price", { precision: 12, scale: 2 }),
    finalPrice: decimal("final_price", { precision: 12, scale: 2 }),
    status: text("status").default("pending").notNull(),
    cancellationReason: text("cancellation_reason"),
    cancelledBy: bigint("cancelled_by", { mode: "number" }).references(
      () => users.id,
      { onDelete: "set null" },
    ),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index("bookings_user_status_idx").on(t.userId, t.status),
    index("bookings_provider_status_idx").on(t.providerId, t.status),
    index("bookings_preferred_date_idx").on(t.preferredDate),
  ],
);

// ─── reviews (polymorphic: Store | ServiceProvider) ───────────────────────

export const reviews = pgTable(
  "reviews",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    uuid: uuid("uuid").notNull().unique().defaultRandom(),
    userId: bigint("user_id", { mode: "number" })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    reviewableType: text("reviewable_type").notNull(),
    reviewableId: bigint("reviewable_id", { mode: "number" }).notNull(),
    bookingId: bigint("booking_id", { mode: "number" }).references(
      () => bookings.id,
      { onDelete: "set null" },
    ),
    rating: smallint("rating").notNull(),
    comment: text("comment"),
    reply: text("reply"),
    repliedBy: bigint("replied_by", { mode: "number" }).references(
      () => users.id,
      { onDelete: "set null" },
    ),
    repliedAt: timestamp("replied_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index("reviews_reviewable_rating_idx").on(
      t.reviewableType,
      t.reviewableId,
      t.rating,
    ),
    index("reviews_user_idx").on(t.userId),
  ],
);

// ─── transactions ─────────────────────────────────────────────────────────

export const transactions = pgTable(
  "transactions",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    uuid: uuid("uuid").notNull().unique().defaultRandom(),
    userId: bigint("user_id", { mode: "number" })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    bookingId: bigint("booking_id", { mode: "number" }).references(
      () => bookings.id,
      { onDelete: "set null" },
    ),
    reference: text("reference").notNull().unique(),
    paystackReference: text("paystack_reference"),
    amount: decimal("amount", { precision: 12, scale: 2 }).notNull(),
    amountKobo: integer("amount_kobo").notNull(),
    currency: varchar("currency", { length: 3 }).default("NGN").notNull(),
    channel: text("channel"),
    status: text("status").default("pending").notNull(),
    gatewayResponse: text("gateway_response"),
    ipAddress: text("ip_address"),
    metadata: jsonb("metadata"),
    authorization: jsonb("authorization"),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index("transactions_user_status_idx").on(t.userId, t.status),
    index("transactions_reference_idx").on(t.reference),
  ],
);

// ─── listings / listing_images / recently_viewed / favorites ──────────────

export const listings = pgTable(
  "listings",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    uuid: uuid("uuid").notNull().unique().defaultRandom(),
    userId: bigint("user_id", { mode: "number" })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    storeId: bigint("store_id", { mode: "number" }).references(() => stores.id, {
      onDelete: "set null",
    }),
    categoryId: bigint("category_id", { mode: "number" })
      .notNull()
      .references(() => categories.id, { onDelete: "restrict" }),
    subcategoryId: bigint("subcategory_id", { mode: "number" }).references(
      () => subcategories.id,
      { onDelete: "set null" },
    ),
    stateId: bigint("state_id", { mode: "number" })
      .notNull()
      .references(() => states.id, { onDelete: "restrict" }),
    sublocationId: bigint("sublocation_id", { mode: "number" }).references(
      () => sublocations.id,
      { onDelete: "set null" },
    ),
    categorySpecificFields: jsonb("category_specific_fields"),
    title: text("title").notNull(),
    slug: text("slug").notNull().unique(),
    description: text("description").notNull(),
    // Pricing
    price: decimal("price", { precision: 12, scale: 2 }).notNull(),
    discountPrice: decimal("discount_price", { precision: 12, scale: 2 }),
    discountPercentage: integer("discount_percentage").default(0).notNull(),
    isDiscounted: boolean("is_discounted").default(false).notNull(),
    // Details
    condition: text("condition").default("used").notNull(),
    listingScope: text("listing_scope").default("personal").notNull(),
    dealType: text("deal_type").default("standard").notNull(),
    // Status & approval
    status: text("status").default("pending").notNull(),
    approved: boolean("approved").default(false).notNull(),
    // Promotion
    promoted: boolean("promoted").default(false).notNull(),
    promotionType: text("promotion_type"),
    promotionExpiry: timestamp("promotion_expiry", { withTimezone: true }),
    featured: boolean("featured").default(false).notNull(),
    // Analytics
    viewsCount: bigint("views_count", { mode: "number" }).default(0).notNull(),
    clicksCount: bigint("clicks_count", { mode: "number" }).default(0).notNull(),
    favoritesCount: bigint("favorites_count", { mode: "number" })
      .default(0)
      .notNull(),
    // Location specifics
    latitude: decimal("latitude", { precision: 10, scale: 7 }),
    longitude: decimal("longitude", { precision: 10, scale: 7 }),
    ...softDelete,
    ...timestamps,
  },
  (t) => [
    index("listings_status_category_idx").on(t.status, t.categoryId),
    index("listings_deal_type_idx").on(t.dealType),
    index("listings_promoted_idx").on(t.promoted),
  ],
);

export const listingImages = pgTable("listing_images", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  listingId: bigint("listing_id", { mode: "number" })
    .notNull()
    .references(() => listings.id, { onDelete: "cascade" }),
  path: text("path").notNull(),
  url: text("url"),
  isPrimary: boolean("is_primary").default(false).notNull(),
  ...softDelete,
  ...timestamps,
});

export const recentlyViewedListings = pgTable(
  "recently_viewed_listings",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    userId: bigint("user_id", { mode: "number" })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    listingId: bigint("listing_id", { mode: "number" })
      .notNull()
      .references(() => listings.id, { onDelete: "cascade" }),
    viewedAt: timestamp("viewed_at", { withTimezone: true }).defaultNow().notNull(),
    ...softDelete,
  },
  (t) => [unique("recently_viewed_user_listing_unique").on(t.userId, t.listingId)],
);

export const favoriteListings = pgTable(
  "favorite_listings",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    userId: bigint("user_id", { mode: "number" })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    listingId: bigint("listing_id", { mode: "number" })
      .notNull()
      .references(() => listings.id, { onDelete: "cascade" }),
    ...softDelete,
    ...timestamps,
  },
  (t) => [unique("favorite_listings_user_listing_unique").on(t.userId, t.listingId)],
);

// ─── saved_searches ───────────────────────────────────────────────────────

export const savedSearches = pgTable(
  "saved_searches",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    userId: bigint("user_id", { mode: "number" })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    filters: jsonb("filters").notNull(),
    ...timestamps,
  },
  (t) => [index("saved_searches_user_created_idx").on(t.userId, t.createdAt)],
);

// ─── chat_messages (Firebase RTDB is realtime; this is the archive) ───────

export const chatMessages = pgTable(
  "chat_messages",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    conversationId: varchar("conversation_id", { length: 191 }).notNull(),
    participantKey: varchar("participant_key", { length: 64 }).notNull(),
    clientMessageId: varchar("client_message_id", { length: 128 }).notNull(),
    senderId: bigint("sender_id", { mode: "number" })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    receiverId: bigint("receiver_id", { mode: "number" })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    message: text("message"),
    messageType: chatMessageTypeEnum("message_type").default("text").notNull(),
    attachmentUrl: varchar("attachment_url", { length: 2048 }),
    readAt: timestamp("read_at", { withTimezone: true }),
    ...softDelete,
    ...timestamps,
  },
  (t) => [
    unique("chat_messages_client_dedupe_unique").on(
      t.conversationId,
      t.senderId,
      t.clientMessageId,
    ),
    index("chat_messages_conversation_created_idx").on(
      t.conversationId,
      t.createdAt,
    ),
    index("chat_messages_participant_created_idx").on(
      t.participantKey,
      t.createdAt,
    ),
    index("chat_messages_receiver_read_idx").on(t.receiverId, t.readAt),
  ],
);

// ─── adverts ──────────────────────────────────────────────────────────────

export const adverts = pgTable(
  "adverts",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    uuid: uuid("uuid").notNull().unique().defaultRandom(),
    userId: bigint("user_id", { mode: "number" })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Listing uuid (no FK — mirrors foreignUuid without constraint). */
    listingId: uuid("listing_id"),
    storeId: uuid("store_id"),
    title: text("title").notNull(),
    description: text("description"),
    imagePath: text("image_path"),
    targetUrl: text("target_url"),
    placement: varchar("placement", { length: 50 }).default("banner").notNull(),
    packageId: varchar("package_id", { length: 50 }),
    durationDays: integer("duration_days").default(7).notNull(),
    status: varchar("status", { length: 20 }).default("pending").notNull(),
    amountPaid: decimal("amount_paid", { precision: 10, scale: 2 })
      .default("0")
      .notNull(),
    paymentReference: varchar("payment_reference", { length: 100 }),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index("adverts_status_expires_idx").on(t.status, t.expiresAt),
    index("adverts_user_idx").on(t.userId),
  ],
);

// ─── referral_attributions ────────────────────────────────────────────────

export const referralAttributions = pgTable(
  "referral_attributions",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    uuid: uuid("uuid").notNull().unique().defaultRandom(),
    userId: bigint("user_id", { mode: "number" }).references(() => users.id, {
      onDelete: "set null",
    }),
    referralCode: text("referral_code"),
    campaignId: text("campaign_id"),
    status: varchar("status", { length: 20 }).default("pending").notNull(),
    registeredUserId: bigint("registered_user_id", { mode: "number" }).references(
      () => users.id,
      { onDelete: "set null" },
    ),
    metadata: jsonb("metadata"),
    registeredAt: timestamp("registered_at", { withTimezone: true }),
    convertedAt: timestamp("converted_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index("referral_attributions_code_idx").on(t.referralCode),
    index("referral_attributions_status_created_idx").on(t.status, t.createdAt),
  ],
);

// ─── safety_reports ───────────────────────────────────────────────────────

export const safetyReports = pgTable(
  "safety_reports",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    uuid: uuid("uuid").notNull().unique().defaultRandom(),
    reporterId: bigint("reporter_id", { mode: "number" })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    reportType: varchar("report_type", { length: 40 }).notNull(),
    message: text("message").notNull(),
    /** Listing uuid (no FK — mirrors foreignUuid without constraint). */
    listingId: uuid("listing_id"),
    reportedUserId: bigint("reported_user_id", { mode: "number" }).references(
      () => users.id,
      { onDelete: "set null" },
    ),
    status: varchar("status", { length: 20 }).default("pending").notNull(),
    ...timestamps,
  },
  (t) => [
    index("safety_reports_status_created_idx").on(t.status, t.createdAt),
    index("safety_reports_reporter_idx").on(t.reporterId),
  ],
);

// ─── store_views & profile_views ──────────────────────────────────────────

export const storeViews = pgTable(
  "store_views",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    storeId: bigint("store_id", { mode: "number" })
      .notNull()
      .references(() => stores.id, { onDelete: "cascade" }),
    viewerId: bigint("viewer_id", { mode: "number" }).references(() => users.id, {
      onDelete: "set null",
    }),
    ipAddress: varchar("ip_address", { length: 45 }),
    userAgent: text("user_agent"),
    viewedAt: timestamp("viewed_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("store_views_store_viewed_idx").on(t.storeId, t.viewedAt),
    index("store_views_viewer_viewed_idx").on(t.viewerId, t.viewedAt),
  ],
);

export const profileViews = pgTable(
  "profile_views",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    userId: bigint("user_id", { mode: "number" })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    viewerId: bigint("viewer_id", { mode: "number" }).references(() => users.id, {
      onDelete: "set null",
    }),
    ipAddress: varchar("ip_address", { length: 45 }),
    userAgent: text("user_agent"),
    viewedAt: timestamp("viewed_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("profile_views_user_viewed_idx").on(t.userId, t.viewedAt),
    index("profile_views_viewer_viewed_idx").on(t.viewerId, t.viewedAt),
  ],
);

export const serviceProviderViews = pgTable(
  "service_provider_views",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    serviceProviderId: bigint("service_provider_id", { mode: "number" })
      .notNull()
      .references(() => serviceProviders.id, { onDelete: "cascade" }),
    viewerId: bigint("viewer_id", { mode: "number" }).references(() => users.id, {
      onDelete: "set null",
    }),
    ipAddress: varchar("ip_address", { length: 45 }),
    userAgent: text("user_agent"),
    viewedAt: timestamp("viewed_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("service_provider_views_provider_viewed_idx").on(
      t.serviceProviderId,
      t.viewedAt,
    ),
    index("service_provider_views_viewer_viewed_idx").on(
      t.viewerId,
      t.viewedAt,
    ),
  ],
);

// ─── item_requests & item_request_responses ────────────────────────────────

export const itemRequests = pgTable(
  "item_requests",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    uuid: uuid("uuid").notNull().unique().defaultRandom(),
    userId: bigint("user_id", { mode: "number" })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: varchar("title", { length: 255 }).notNull(),
    description: text("description").notNull(),
    categoryId: bigint("category_id", { mode: "number" }).references(
      () => categories.id,
      { onDelete: "set null" },
    ),
    subcategoryId: bigint("subcategory_id", { mode: "number" }).references(
      () => subcategories.id,
      { onDelete: "set null" },
    ),
    stateId: bigint("state_id", { mode: "number" }).references(
      () => states.id,
      { onDelete: "set null" },
    ),
    sublocationId: bigint("sublocation_id", { mode: "number" }).references(
      () => sublocations.id,
      { onDelete: "set null" },
    ),
    budgetMin: decimal("budget_min", { precision: 12, scale: 2 }),
    budgetMax: decimal("budget_max", { precision: 12, scale: 2 }),
    images: jsonb("images"),
    status: varchar("status", { length: 32 }).default("open").notNull(),
    responsesCount: integer("responses_count").default(0).notNull(),
    broadcastCount: integer("broadcast_count").default(0).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index("item_requests_status_idx").on(t.status),
    index("item_requests_created_at_idx").on(t.createdAt),
    index("item_requests_state_status_idx").on(t.stateId, t.status),
    index("item_requests_category_status_idx").on(t.categoryId, t.status),
  ],
);

export const itemRequestResponses = pgTable(
  "item_request_responses",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    uuid: uuid("uuid").notNull().unique().defaultRandom(),
    itemRequestId: bigint("item_request_id", { mode: "number" })
      .notNull()
      .references(() => itemRequests.id, { onDelete: "cascade" }),
    storeId: bigint("store_id", { mode: "number" })
      .notNull()
      .references(() => stores.id, { onDelete: "cascade" }),
    userId: bigint("user_id", { mode: "number" })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    price: decimal("price", { precision: 12, scale: 2 }).notNull(),
    message: text("message").notNull(),
    listingId: bigint("listing_id", { mode: "number" }).references(
      () => listings.id,
      { onDelete: "set null" },
    ),
    images: jsonb("images"),
    status: varchar("status", { length: 32 }).default("pending").notNull(),
    ...timestamps,
  },
  (t) => [
    unique("req_store_response_unique").on(t.itemRequestId, t.storeId),
    index("item_request_responses_user_idx").on(t.userId),
    index("item_request_responses_store_idx").on(t.storeId),
    index("item_request_responses_status_idx").on(t.status),
    index("item_request_responses_created_at_idx").on(t.createdAt),
  ],
);

// ─── system_settings ───────────────────────────────────────────────────────

export const systemSettings = pgTable(
  "system_settings",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    key: varchar("key", { length: 255 }).notNull().unique(),
    value: text("value"),
    group: varchar("group", { length: 100 }).default("general").notNull(),
    ...timestamps,
  },
  (t) => [
    index("system_settings_key_idx").on(t.key),
    index("system_settings_group_idx").on(t.group),
  ],
);

