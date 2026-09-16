/**
 * Admin module — Elysia plugin, prefix /api/v1/admin.
 *
 * Port of the Laravel reference Admin controllers:
 *   AdminDashboardController, KycReviewController, ApplicationReviewController,
 *   UserManagementController, MarketController, SupportTicketReviewController,
 *   ContactUpdateReviewController, AdvertReviewController,
 *   ListingReviewController, ListingFeatureController,
 *   NotificationBroadcastController
 *
 * Staff routes require the admin|verifier roles; user suspension, role
 * assignment, listing featuring and notification broadcasts are admin-only
 * (mirrors routes/api.php in the reference).
 *
 * All responses use the envelope { success, message, data } (+ optional meta
 * for paginated lists).
 *
 * Auth: real JWT guard (applyAuthGuard) resolving the shared UserStore; roles
 * are read from `currentUser.roles` (the JWT carries only `sub`). Handlers
 * return 401/403 through the same envelope.
 *
 * Persistence: in-memory AdminStore behind a small class with reset().
 * TODO(db): back each collection with drizzle (users, kyc_profiles,
 * seller_applications, provider_applications, markets, support_tickets,
 * contact_updates, adverts, listings, notification_broadcasts, admin_logs)
 * and record an admin_logs row per mutating action.
 */
import { Elysia, t } from "elysia";
import { applyAuthGuard, type UserStore } from "../auth/index";
import { getDbStores } from "../../db/stores";
import { newId, nowIso } from "../../utils/phone";

// ── Envelope ─────────────────────────────────────────────────────────────────

export function ok<T>(message: string, data: T, meta?: Record<string, unknown>): {
  success: true;
  message: string;
  data: T;
  meta?: Record<string, unknown>;
} {
  return { success: true, message, data, ...(meta === undefined ? {} : { meta }) };
}

export function fail(message: string): {
  success: false;
  message: string;
  data: null;
} {
  return { success: false, message, data: null };
}

// ── Staff guard ──────────────────────────────────────────────────────────────

export interface StaffUser {
  id: string;
  name: string;
  roles: string[];
}

/**
 * Pipe-separated ("admin|verifier") or array role check, mirroring Laravel's
 * `role:admin|verifier` middleware.
 */
export function hasRequiredRole(userRoles: string[], required: string | string[]): boolean {
  const needed = (Array.isArray(required) ? required : required.split("|"))
    .map((role) => role.trim())
    .filter((role) => role.length > 0);
  return needed.some((role) => userRoles.includes(role));
}

/** Returns an error descriptor when the user lacks access, else null. */
export function staffAccessError(
  user: StaffUser | null,
  required: string | string[],
): { status: 401 | 403; message: string } | null {
  if (!user) return { status: 401, message: "Unauthenticated." };
  if (!hasRequiredRole(user.roles, required)) {
    return { status: 403, message: "Forbidden. Staff access required." };
  }
  return null;
}

// ── Dashboard stats ──────────────────────────────────────────────────────────

export interface DashboardCounts {
  totalUsers: number;
  totalListings: number;
  activeListings: number;
  pendingListings: number;
  totalStores: number;
  totalProviders: number;
  totalTransactions: number;
  revenueTotal: number;
}

export interface DashboardStats {
  total_users: number;
  total_listings: number;
  active_listings: number;
  pending_listings: number;
  total_stores: number;
  total_providers: number;
  total_transactions: number;
  revenue_total: number;
}

/** Shape mirrors AdminDashboardController::stats() in the reference. */
export function buildDashboardStats(counts: DashboardCounts): DashboardStats {
  return {
    total_users: counts.totalUsers,
    total_listings: counts.totalListings,
    active_listings: counts.activeListings,
    pending_listings: counts.pendingListings,
    total_stores: counts.totalStores,
    total_providers: counts.totalProviders,
    total_transactions: counts.totalTransactions,
    revenue_total: counts.revenueTotal,
  };
}

// ── Store ────────────────────────────────────────────────────────────────────

export interface AdminManagedUser {
  id: string;
  name: string;
  email: string | null;
  roles: string[];
  state: string | null;
  isSuspended: boolean;
  suspensionReason: string | null;
  createdAt: string;
}

export interface KycReviewItem {
  id: string;
  userId: string;
  tier: 1 | 2;
  status: "pending" | "approved" | "rejected";
  rejectionReason: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  createdAt: string;
}

export interface ApplicationItem {
  id: string;
  userId: string;
  status: "pending" | "approved" | "declined";
  declinedReason: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  createdAt: string;
}

export interface MarketItem {
  id: string;
  name: string;
  slug: string;
  stateId: string;
  sublocationId: string | null;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  isActive: boolean;
  createdAt: string;
}

export interface SupportTicketItem {
  id: string;
  ticketNumber: string;
  userId: string;
  subject: string;
  status: string;
  priority: string;
  category: string;
  assignedTo: string | null;
  createdAt: string;
}

export interface ContactUpdateItem {
  id: string;
  providerId: string;
  proposedChanges: Record<string, unknown>;
  status: "pending" | "approved" | "rejected";
  reviewedBy: string | null;
  reviewedAt: string | null;
  createdAt: string;
}

export interface AdvertItem {
  id: string;
  userId: string;
  title: string;
  status: "pending" | "active" | "expired" | "unpublished";
  durationDays: number;
  amountPaid: number;
  publishedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

export interface ListingReviewItem {
  id: string;
  userId: string;
  title: string;
  dealType: string;
  status: string;
  approved: boolean;
  featured: boolean;
  promoted: boolean;
  promotionType: string | null;
  promotionExpiry: string | null;
  createdAt: string;
}

export interface BroadcastItem {
  id: string;
  adminId: string;
  audience: string;
  title: string;
  body: string;
  type: string;
  channels: string[];
  recipientCount: number;
  status: string;
  createdAt: string;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const BROADCAST_AUDIENCES = ["all", "role", "state", "users"] as const;
const BROADCAST_CHANNELS = ["push", "email", "sms"] as const;
/** Mirrors NotificationBroadcastController::SMS_RECIPIENT_CAP in the reference. */
export const SMS_RECIPIENT_CAP = 500;
/** Mirrors the throttle:3,60 middleware on the broadcast route. */
export const BROADCAST_THROTTLE_LIMIT = 3;
export const BROADCAST_THROTTLE_WINDOW_MS = 60_000;

export class AdminStore {
  users = new Map<string, AdminManagedUser>();
  kyc = new Map<string, KycReviewItem>();
  sellerApps = new Map<string, ApplicationItem>();
  providerApps = new Map<string, ApplicationItem>();
  markets = new Map<string, MarketItem>();
  tickets = new Map<string, SupportTicketItem>();
  contactUpdates = new Map<string, ContactUpdateItem>();
  adverts = new Map<string, AdvertItem>();
  listings = new Map<string, ListingReviewItem>();
  broadcasts: BroadcastItem[] = [];
  /** Extra aggregate counters with no backing collection in this store. */
  counters = { totalStores: 0, totalProviders: 0, totalTransactions: 0, revenueTotal: 0 };
  private broadcastHits = new Map<string, number[]>();

  reset(): void {
    this.users.clear();
    this.kyc.clear();
    this.sellerApps.clear();
    this.providerApps.clear();
    this.markets.clear();
    this.tickets.clear();
    this.contactUpdates.clear();
    this.adverts.clear();
    this.listings.clear();
    this.broadcasts = [];
    this.counters = { totalStores: 0, totalProviders: 0, totalTransactions: 0, revenueTotal: 0 };
    this.broadcastHits.clear();
  }

  dashboardStats(): DashboardStats {
    const listings = [...this.listings.values()];
    return buildDashboardStats({
      totalUsers: this.users.size,
      totalListings: listings.length,
      activeListings: listings.filter((listing) => listing.status === "active").length,
      pendingListings: listings.filter((listing) => listing.status === "pending").length,
      totalStores: this.counters.totalStores,
      totalProviders: this.counters.totalProviders,
      totalTransactions: this.counters.totalTransactions,
      revenueTotal: this.counters.revenueTotal,
    });
  }

  /** Sliding-window broadcast throttle. Returns false when the admin is throttled. */
  checkBroadcastThrottle(adminId: string, now: number = Date.now()): boolean {
    const windowStart = now - BROADCAST_THROTTLE_WINDOW_MS;
    const hits = (this.broadcastHits.get(adminId) ?? []).filter((at) => at > windowStart);
    if (hits.length >= BROADCAST_THROTTLE_LIMIT) {
      this.broadcastHits.set(adminId, hits);
      return false;
    }
    hits.push(now);
    this.broadcastHits.set(adminId, hits);
    return true;
  }

  recipientCount(audience: string, role?: string, state?: string, userIds?: string[]): number {
    const users = [...this.users.values()].filter((user) => !user.isSuspended);
    switch (audience) {
      case "role":
        return users.filter((user) => (role ? user.roles.includes(role) : false)).length;
      case "state":
        return users.filter((user) => (state ? user.state === state : false)).length;
      case "users":
        return Math.min(userIds?.length ?? 0, 1000);
      default:
        return users.length;
    }
  }
}

/** Default singleton (override via plugin options in tests). */
export const adminStore = new AdminStore();

// ── Serializers (snake_case, mirroring the Laravel API) ─────────────────────

function serializeUser(user: AdminManagedUser): Record<string, unknown> {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    roles: user.roles,
    is_suspended: user.isSuspended,
    suspension_reason: user.suspensionReason,
    created_at: user.createdAt,
  };
}

function serializeMarket(market: MarketItem): Record<string, unknown> {
  return {
    id: market.id,
    name: market.name,
    slug: market.slug,
    state_id: market.stateId,
    sublocation_id: market.sublocationId,
    address: market.address,
    latitude: market.latitude,
    longitude: market.longitude,
    is_active: market.isActive,
    created_at: market.createdAt,
  };
}

function paginate<T>(items: T[], page: number, perPage: number): { data: T[]; meta: Record<string, unknown> } {
  const total = items.length;
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  const currentPage = Math.min(Math.max(1, page), lastPage);
  const start = (currentPage - 1) * perPage;
  return {
    data: items.slice(start, start + perPage),
    meta: { current_page: currentPage, per_page: perPage, total, last_page: lastPage },
  };
}

// ── Schemas ──────────────────────────────────────────────────────────────────

const PaginationQuery = t.Object({
  page: t.Optional(t.Numeric({ minimum: 1 })),
  per_page: t.Optional(t.Numeric({ minimum: 1, maximum: 100 })),
});

const KycQuery = t.Object({
  status: t.Optional(t.Union([t.Literal("pending"), t.Literal("approved"), t.Literal("rejected")])),
  tier: t.Optional(t.Union([t.Literal(1), t.Literal(2)])),
  page: t.Optional(t.Numeric({ minimum: 1 })),
  per_page: t.Optional(t.Numeric({ minimum: 1, maximum: 100 })),
});

const ReasonBody = t.Object({
  reason: t.String({ minLength: 1, maxLength: 500 }),
});

const UsersQuery = t.Object({
  role: t.Optional(t.String({ maxLength: 64 })),
  search: t.Optional(t.String({ maxLength: 100 })),
  page: t.Optional(t.Numeric({ minimum: 1 })),
  per_page: t.Optional(t.Numeric({ minimum: 1, maximum: 100 })),
});

const AssignRoleBody = t.Object({
  role: t.Union([t.Literal("admin"), t.Literal("verifier"), t.Literal("shop_manager")]),
  action: t.Union([t.Literal("grant"), t.Literal("revoke")]),
});

const MarketBody = t.Object({
  state_id: t.String({ minLength: 1 }),
  sublocation_id: t.Optional(t.String()),
  name: t.String({ minLength: 1, maxLength: 255 }),
  address: t.Optional(t.String({ maxLength: 500 })),
  latitude: t.Optional(t.Number({ minimum: -90, maximum: 90 })),
  longitude: t.Optional(t.Number({ minimum: -180, maximum: 180 })),
});

const MarketUpdateBody = t.Object({
  name: t.Optional(t.String({ minLength: 1, maxLength: 255 })),
  address: t.Optional(t.String({ maxLength: 500 })),
  latitude: t.Optional(t.Number({ minimum: -90, maximum: 90 })),
  longitude: t.Optional(t.Number({ minimum: -180, maximum: 180 })),
  is_active: t.Optional(t.Boolean()),
});

const AssignTicketBody = t.Object({
  agent_id: t.Optional(t.String({ minLength: 1 })),
});

const AdvertsQuery = t.Object({
  status: t.Optional(
    t.Union([t.Literal("pending"), t.Literal("active"), t.Literal("expired"), t.Literal("unpublished")]),
  ),
  page: t.Optional(t.Numeric({ minimum: 1 })),
  per_page: t.Optional(t.Numeric({ minimum: 1, maximum: 100 })),
});

const ListingsQuery = t.Object({
  deal_type: t.Optional(t.String({ maxLength: 64 })),
  /** "all" returns every listing; anything else returns unapproved only. */
  status: t.Optional(t.String({ maxLength: 16 })),
  page: t.Optional(t.Numeric({ minimum: 1 })),
  per_page: t.Optional(t.Numeric({ minimum: 1, maximum: 100 })),
});

const FeatureBody = t.Object({
  featured: t.Optional(t.Boolean()),
  promotion_type: t.Optional(t.String({ maxLength: 60 })),
  days: t.Optional(t.Integer({ minimum: 1, maximum: 90 })),
});

const BroadcastBody = t.Object({
  title: t.String({ minLength: 1, maxLength: 120 }),
  body: t.String({ minLength: 1, maxLength: 500 }),
  type: t.Optional(t.String({ maxLength: 60 })),
  data: t.Optional(t.Record(t.String(), t.Unknown())),
  channels: t.Optional(t.Array(t.Union([t.Literal("push"), t.Literal("email"), t.Literal("sms")]))),
  audience: t.Optional(
    t.Union([t.Literal("all"), t.Literal("role"), t.Literal("state"), t.Literal("users")]),
  ),
  role: t.Optional(t.String({ maxLength: 64 })),
  state: t.Optional(t.String({ maxLength: 120 })),
  user_ids: t.Optional(t.Array(t.String(), { maxItems: 1000 })),
  dry_run: t.Optional(t.Boolean()),
  confirm: t.Optional(t.Boolean()),
});

// ── Plugin ───────────────────────────────────────────────────────────────────

export interface AdminPluginOptions {
  store?: AdminStore;
  users?: UserStore;
  secret?: string;
}

const STAFF = "admin|verifier";

export function createAdminPlugin(options: AdminPluginOptions = {}) {
  const store = options.store ?? adminStore;

  return (
    applyAuthGuard(new Elysia({ prefix: "/api/v1/admin" }), {
      secret: options.secret,
      users: options.users ?? getDbStores()?.users,
    })
      .resolve(({ currentUser }) => ({
        staff: currentUser
          ? { id: currentUser.id, name: currentUser.name ?? "Staff", roles: currentUser.roles }
          : null,
      }))
      // ── Dashboard ──────────────────────────────────────────────────
      .get("/dashboard/stats", ({ staff, status }) => {
        const denied = staffAccessError(staff, STAFF);
        if (denied) return status(denied.status, fail(denied.message));
        return ok("Dashboard stats retrieved.", store.dashboardStats());
      })

      // ── KYC review ─────────────────────────────────────────────────
      .get("/kyc", ({ staff, headers, status, query }) => {
        const denied = staffAccessError(staff, STAFF);
        if (denied) return status(denied.status, fail(denied.message));
        const items = [...store.kyc.values()]
          .filter((item) => !query.status || item.status === query.status)
          .filter((item) => !query.tier || item.tier === query.tier)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        const { data, meta } = paginate(items, query.page ?? 1, query.per_page ?? 20);
        return ok("KYC submissions retrieved.", data, meta);
      }, { query: KycQuery })
      .post("/kyc/:id/approve", ({ staff, headers, status, params }) => {
        const denied = staffAccessError(staff, STAFF);
        if (denied) return status(denied.status, fail(denied.message));
        const item = store.kyc.get(params.id);
        if (!item) return status(404, fail("KYC submission not found."));
        item.status = "approved";
        item.rejectionReason = null;
        item.reviewedBy = (staff as StaffUser).id;
        item.reviewedAt = nowIso();
        // TODO(db): notify the user (kyc_approval) via NotificationService port.
        return ok(`KYC #${item.id} approved. User can now apply for roles.`, {
          id: item.id,
          tier: item.tier,
          status: item.status,
        });
      })
      .post("/kyc/:id/reject", ({ staff, headers, status, params, body }) => {
        const denied = staffAccessError(staff, STAFF);
        if (denied) return status(denied.status, fail(denied.message));
        const item = store.kyc.get(params.id);
        if (!item) return status(404, fail("KYC submission not found."));
        item.status = "rejected";
        item.rejectionReason = body.reason;
        item.reviewedBy = (staff as StaffUser).id;
        item.reviewedAt = nowIso();
        return ok(`KYC #${item.id} rejected.`, { id: item.id, reason: body.reason });
      }, { body: ReasonBody })

      // ── Role applications ──────────────────────────────────────────
      .get("/applications/sellers", ({ staff, headers, status, query }) => {
        const denied = staffAccessError(staff, STAFF);
        if (denied) return status(denied.status, fail(denied.message));
        const items = [...store.sellerApps.values()].sort((a, b) =>
          b.createdAt.localeCompare(a.createdAt),
        );
        const { data, meta } = paginate(items, query.page ?? 1, query.per_page ?? 20);
        return ok("Seller applications retrieved.", data, meta);
      }, { query: PaginationQuery })
      .post("/applications/sellers/:id/approve", ({ staff, headers, status, params }) => {
        const denied = staffAccessError(staff, STAFF);
        if (denied) return status(denied.status, fail(denied.message));
        const app = store.sellerApps.get(params.id);
        if (!app) return status(404, fail("Seller application not found."));
        app.status = "approved";
        app.reviewedBy = (staff as StaffUser).id;
        app.reviewedAt = nowIso();
        const user = store.users.get(app.userId);
        if (user && !user.roles.includes("seller")) user.roles.push("seller");
        return ok("Seller application approved.", { id: app.id, status: app.status });
      })
      .post("/applications/sellers/:id/decline", ({ staff, headers, status, params, body }) => {
        const denied = staffAccessError(staff, STAFF);
        if (denied) return status(denied.status, fail(denied.message));
        const app = store.sellerApps.get(params.id);
        if (!app) return status(404, fail("Seller application not found."));
        app.status = "declined";
        app.declinedReason = body.reason;
        app.reviewedBy = (staff as StaffUser).id;
        app.reviewedAt = nowIso();
        return ok("Seller application declined.", { id: app.id });
      }, { body: ReasonBody })
      .get("/applications/providers", ({ staff, headers, status, query }) => {
        const denied = staffAccessError(staff, STAFF);
        if (denied) return status(denied.status, fail(denied.message));
        const items = [...store.providerApps.values()].sort((a, b) =>
          b.createdAt.localeCompare(a.createdAt),
        );
        const { data, meta } = paginate(items, query.page ?? 1, query.per_page ?? 20);
        return ok("Provider applications retrieved.", data, meta);
      }, { query: PaginationQuery })
      .post("/applications/providers/:id/approve", ({ staff, headers, status, params }) => {
        const denied = staffAccessError(staff, STAFF);
        if (denied) return status(denied.status, fail(denied.message));
        const app = store.providerApps.get(params.id);
        if (!app) return status(404, fail("Provider application not found."));
        app.status = "approved";
        app.reviewedBy = (staff as StaffUser).id;
        app.reviewedAt = nowIso();
        const user = store.users.get(app.userId);
        if (user && !user.roles.includes("provider")) user.roles.push("provider");
        return ok("Provider application approved.", { id: app.id, status: app.status });
      })
      .post("/applications/providers/:id/decline", ({ staff, headers, status, params, body }) => {
        const denied = staffAccessError(staff, STAFF);
        if (denied) return status(denied.status, fail(denied.message));
        const app = store.providerApps.get(params.id);
        if (!app) return status(404, fail("Provider application not found."));
        app.status = "declined";
        app.declinedReason = body.reason;
        app.reviewedBy = (staff as StaffUser).id;
        app.reviewedAt = nowIso();
        return ok("Provider application declined.", { id: app.id });
      }, { body: ReasonBody })

      // ── User management ────────────────────────────────────────────
      .get("/users", ({ staff, headers, status, query }) => {
        const denied = staffAccessError(staff, STAFF);
        if (denied) return status(denied.status, fail(denied.message));
        const search = query.search?.toLowerCase();
        const items = [...store.users.values()]
          .filter((user) => !query.role || user.roles.includes(query.role))
          .filter(
            (user) =>
              !search ||
              user.name.toLowerCase().includes(search) ||
              (user.email ?? "").toLowerCase().includes(search),
          )
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .map(serializeUser);
        const { data, meta } = paginate(items, query.page ?? 1, query.per_page ?? 25);
        return ok("Users retrieved.", data, meta);
      }, { query: UsersQuery })
      .post("/users/:id/suspend", ({ staff, headers, status, params, body }) => {
        const denied = staffAccessError(staff, "admin");
        if (denied) return status(denied.status, fail(denied.message));
        const user = store.users.get(params.id);
        if (!user) return status(404, fail("User not found."));
        user.isSuspended = true;
        user.suspensionReason = body.reason;
        // TODO(db): revoke the user's API tokens so suspension logs them out.
        return ok(`User [${user.name}] has been suspended.`, serializeUser(user));
      }, { body: ReasonBody })
      .post("/users/:id/unsuspend", ({ staff, headers, status, params }) => {
        const denied = staffAccessError(staff, "admin");
        if (denied) return status(denied.status, fail(denied.message));
        const user = store.users.get(params.id);
        if (!user) return status(404, fail("User not found."));
        user.isSuspended = false;
        user.suspensionReason = null;
        return ok(`User [${user.name}] has been unsuspended.`, serializeUser(user));
      })
      .post("/users/:id/assign-role", ({ staff, headers, status, params, body }) => {
        const denied = staffAccessError(staff, "admin");
        if (denied) return status(denied.status, fail(denied.message));
        const user = store.users.get(params.id);
        if (!user) return status(404, fail("User not found."));
        if (body.action === "grant") {
          if (!user.roles.includes(body.role)) user.roles.push(body.role);
          return ok(`Role '${body.role}' granted to [${user.name}].`, serializeUser(user));
        }
        user.roles = user.roles.filter((role) => role !== body.role);
        return ok(`Role '${body.role}' revoked from [${user.name}].`, serializeUser(user));
      }, { body: AssignRoleBody })

      // ── Markets ────────────────────────────────────────────────────
      .get("/markets", ({ staff, headers, status, query }) => {
        const denied = staffAccessError(staff, STAFF);
        if (denied) return status(denied.status, fail(denied.message));
        const items = [...store.markets.values()]
          .filter((market) => !query.state_id || market.stateId === query.state_id)
          .sort((a, b) => a.name.localeCompare(b.name))
          .map(serializeMarket);
        const { data, meta } = paginate(items, query.page ?? 1, query.per_page ?? 50);
        return ok("Markets retrieved.", data, meta);
      }, { query: t.Object({
        state_id: t.Optional(t.String()),
        page: t.Optional(t.Numeric({ minimum: 1 })),
        per_page: t.Optional(t.Numeric({ minimum: 1, maximum: 100 })),
      }) })
      .post("/markets", ({ staff, headers, body, status }) => {
        const denied = staffAccessError(staff, STAFF);
        if (denied) return status(denied.status, fail(denied.message));
        const market: MarketItem = {
          id: newId("market"),
          name: body.name,
          slug: slugify(body.name),
          stateId: body.state_id,
          sublocationId: body.sublocation_id ?? null,
          address: body.address ?? null,
          latitude: body.latitude ?? null,
          longitude: body.longitude ?? null,
          isActive: true,
          createdAt: nowIso(),
        };
        store.markets.set(market.id, market);
        return status(201, ok("Market created successfully.", serializeMarket(market)));
      }, { body: MarketBody })
      .put("/markets/:id", ({ staff, headers, status, params, body }) => {
        const denied = staffAccessError(staff, STAFF);
        if (denied) return status(denied.status, fail(denied.message));
        const market = store.markets.get(params.id);
        if (!market) return status(404, fail("Market not found."));
        if (body.name !== undefined) {
          market.name = body.name;
          market.slug = slugify(body.name);
        }
        if (body.address !== undefined) market.address = body.address;
        if (body.latitude !== undefined) market.latitude = body.latitude;
        if (body.longitude !== undefined) market.longitude = body.longitude;
        if (body.is_active !== undefined) market.isActive = body.is_active;
        return ok("Market updated.", serializeMarket(market));
      }, { body: MarketUpdateBody })
      .delete("/markets/:id", ({ staff, headers, status, params }) => {
        const denied = staffAccessError(staff, STAFF);
        if (denied) return status(denied.status, fail(denied.message));
        if (!store.markets.delete(params.id)) return status(404, fail("Market not found."));
        return ok("Market deleted successfully.", null);
      })

      // ── Support queue ──────────────────────────────────────────────
      .get("/support/tickets", ({ staff, headers, status, query }) => {
        const denied = staffAccessError(staff, STAFF);
        if (denied) return status(denied.status, fail(denied.message));
        const items = [...store.tickets.values()]
          .filter((ticket) => !query.status || ticket.status === query.status)
          .filter((ticket) => !query.priority || ticket.priority === query.priority)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        const { data, meta } = paginate(items, query.page ?? 1, query.per_page ?? 20);
        return ok("Support tickets retrieved.", data, meta);
      }, { query: t.Object({
        status: t.Optional(t.String({ maxLength: 32 })),
        priority: t.Optional(t.String({ maxLength: 32 })),
        page: t.Optional(t.Numeric({ minimum: 1 })),
        per_page: t.Optional(t.Numeric({ minimum: 1, maximum: 100 })),
      }) })
      .post("/support/tickets/:id/assign", ({ staff, headers, status, params, body }) => {
        const denied = staffAccessError(staff, STAFF);
        if (denied) return status(denied.status, fail(denied.message));
        const ticket = store.tickets.get(params.id);
        if (!ticket) return status(404, fail("Support ticket not found."));
        const agentId = body.agent_id ?? (staff as StaffUser).id;
        const agent = store.users.get(agentId);
        if (agent && !hasRequiredRole(agent.roles, STAFF)) {
          return status(422, fail("Tickets can only be assigned to an admin or verifier."));
        }
        ticket.assignedTo = agentId;
        return ok(`Ticket ${ticket.ticketNumber} assigned.`, ticket);
      }, { body: AssignTicketBody })

      // ── Contact updates ────────────────────────────────────────────
      .get("/contact-updates", ({ staff, headers, status, query }) => {
        const denied = staffAccessError(staff, STAFF);
        if (denied) return status(denied.status, fail(denied.message));
        const items = [...store.contactUpdates.values()]
          .filter((item) => !query.status || item.status === query.status)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        const { data, meta } = paginate(items, query.page ?? 1, query.per_page ?? 20);
        return ok("Contact updates retrieved.", data, meta);
      }, { query: t.Object({
        status: t.Optional(
          t.Union([t.Literal("pending"), t.Literal("approved"), t.Literal("rejected")]),
        ),
        page: t.Optional(t.Numeric({ minimum: 1 })),
        per_page: t.Optional(t.Numeric({ minimum: 1, maximum: 100 })),
      }) })
      .post("/contact-updates/:id/approve", ({ staff, headers, status, params }) => {
        const denied = staffAccessError(staff, STAFF);
        if (denied) return status(denied.status, fail(denied.message));
        const item = store.contactUpdates.get(params.id);
        if (!item) return status(404, fail("Contact update not found."));
        if (item.status !== "pending") {
          return status(422, fail("This request has already been reviewed."));
        }
        item.status = "approved";
        item.reviewedBy = (staff as StaffUser).id;
        item.reviewedAt = nowIso();
        return ok("Contact update approved and applied.", item);
      })
      .post("/contact-updates/:id/reject", ({ staff, headers, status, params }) => {
        const denied = staffAccessError(staff, STAFF);
        if (denied) return status(denied.status, fail(denied.message));
        const item = store.contactUpdates.get(params.id);
        if (!item) return status(404, fail("Contact update not found."));
        if (item.status !== "pending") {
          return status(422, fail("This request has already been reviewed."));
        }
        item.status = "rejected";
        item.reviewedBy = (staff as StaffUser).id;
        item.reviewedAt = nowIso();
        return ok("Contact update rejected.", item);
      })

      // ── Adverts ────────────────────────────────────────────────────
      .get("/adverts", ({ staff, headers, status, query }) => {
        const denied = staffAccessError(staff, STAFF);
        if (denied) return status(denied.status, fail(denied.message));
        const items = [...store.adverts.values()]
          .filter((advert) => !query.status || advert.status === query.status)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        const { data, meta } = paginate(items, query.page ?? 1, query.per_page ?? 20);
        return ok("Adverts retrieved.", data, meta);
      }, { query: AdvertsQuery })
      .get("/adverts/stats", ({ staff, headers, status }) => {
        const denied = staffAccessError(staff, STAFF);
        if (denied) return status(denied.status, fail(denied.message));
        const adverts = [...store.adverts.values()];
        return ok("Advert stats retrieved.", {
          total: adverts.length,
          active: adverts.filter((advert) => advert.status === "active").length,
          pending: adverts.filter((advert) => advert.status === "pending").length,
          expired: adverts.filter((advert) => advert.status === "expired").length,
          revenue: adverts.reduce((sum, advert) => sum + advert.amountPaid, 0),
        });
      })
      .post("/adverts/:id/publish", ({ staff, headers, status, params }) => {
        const denied = staffAccessError(staff, STAFF);
        if (denied) return status(denied.status, fail(denied.message));
        const advert = store.adverts.get(params.id);
        if (!advert) return status(404, fail("Advert not found."));
        const now = new Date();
        advert.status = "active";
        advert.publishedAt = now.toISOString();
        advert.expiresAt = new Date(
          now.getTime() + advert.durationDays * 24 * 60 * 60 * 1000,
        ).toISOString();
        return ok("Advert published.", advert);
      })
      .post("/adverts/:id/unpublish", ({ staff, headers, status, params }) => {
        const denied = staffAccessError(staff, STAFF);
        if (denied) return status(denied.status, fail(denied.message));
        const advert = store.adverts.get(params.id);
        if (!advert) return status(404, fail("Advert not found."));
        advert.status = "unpublished";
        return ok("Advert unpublished.", advert);
      })

      // ── Listing review ─────────────────────────────────────────────
      .get("/listings", ({ staff, headers, status, query }) => {
        const denied = staffAccessError(staff, STAFF);
        if (denied) return status(denied.status, fail(denied.message));
        const items = [...store.listings.values()]
          .filter((listing) => !query.deal_type || listing.dealType === query.deal_type)
          .filter((listing) => query.status === "all" || !listing.approved)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        const { data, meta } = paginate(items, query.page ?? 1, query.per_page ?? 20);
        return ok("Listings retrieved.", data, meta);
      }, { query: ListingsQuery })
      .post("/listings/:id/approve", ({ staff, headers, status, params }) => {
        const denied = staffAccessError(staff, STAFF);
        if (denied) return status(denied.status, fail(denied.message));
        const listing = store.listings.get(params.id);
        if (!listing) return status(404, fail("Listing not found."));
        listing.approved = true;
        listing.status = "active";
        return ok(`Listing "${listing.title}" approved and is now live.`, listing);
      })
      .post("/listings/:id/reject", ({ staff, headers, status, params, body }) => {
        const denied = staffAccessError(staff, STAFF);
        if (denied) return status(denied.status, fail(denied.message));
        const listing = store.listings.get(params.id);
        if (!listing) return status(404, fail("Listing not found."));
        listing.approved = false;
        listing.status = "inactive";
        return ok(`Listing "${listing.title}" rejected.`, listing);
      }, { body: ReasonBody })
      .post("/listings/:id/feature", ({ staff, headers, status, params, body }) => {
        const denied = staffAccessError(staff, "admin");
        if (denied) return status(denied.status, fail(denied.message));
        const listing = store.listings.get(params.id);
        if (!listing) return status(404, fail("Listing not found."));
        const featured = body.featured ?? true;
        const expiry = featured
          ? new Date(Date.now() + (body.days ?? 7) * 24 * 60 * 60 * 1000).toISOString()
          : null;
        listing.featured = featured;
        listing.promoted = featured;
        listing.promotionType = featured ? (body.promotion_type ?? "featured") : null;
        listing.promotionExpiry = expiry;
        return ok(
          featured ? "Listing featured." : "Listing removed from featured.",
          listing,
        );
      }, { body: FeatureBody })

      // ── Notification broadcasts (admin only, throttled) ────────────
      .get("/notifications/broadcasts", ({ staff, headers, status, query }) => {
        const denied = staffAccessError(staff, "admin");
        if (denied) return status(denied.status, fail(denied.message));
        const items = [...store.broadcasts].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        const { data, meta } = paginate(items, query.page ?? 1, query.per_page ?? 20);
        return ok("Broadcasts retrieved.", { broadcasts: data }, meta);
      }, { query: PaginationQuery })
      .post("/notifications/broadcast", ({ staff, headers, body, status }) => {
        const denied = staffAccessError(staff, "admin");
        if (denied) return status(denied.status, fail(denied.message));
        const adminId = (staff as StaffUser).id;

        const audience = body.audience ?? "all";
        if (audience === "role" && !body.role) {
          return status(422, fail("A role is required when the audience is role."));
        }
        if (audience === "users" && (!body.user_ids || body.user_ids.length === 0)) {
          return status(422, fail("user_ids are required when the audience is users."));
        }

        const recipientCount = store.recipientCount(audience, body.role, body.state, body.user_ids);
        const channels = body.channels ?? ["push"];

        if (body.dry_run) {
          return ok("Dry run — nothing was sent.", {
            dry_run: true,
            recipient_count: recipientCount,
            channels,
          });
        }

        if (!body.confirm) {
          return status(
            422,
            fail('Set "confirm": true to send. Use "dry_run": true to preview the recipient count first.'),
          );
        }

        if (recipientCount === 0) {
          return status(422, fail("This segment matches no users."));
        }

        if (channels.includes("sms") && recipientCount > SMS_RECIPIENT_CAP) {
          return status(
            422,
            fail(
              `An SMS broadcast is capped at ${SMS_RECIPIENT_CAP} recipients; ` +
                `this segment matches ${recipientCount}. Narrow the audience or drop the sms channel.`,
            ),
          );
        }

        // NOTE: throttle mirrors the throttle:3,60 route middleware in the
        // reference. In-memory here — move to Redis/Elysia rate-limit at deploy.
        if (!store.checkBroadcastThrottle(adminId)) {
          return status(429, fail("Too many broadcast requests. Please slow down."));
        }

        const broadcast: BroadcastItem = {
          id: newId("broadcast"),
          adminId,
          audience,
          title: body.title,
          body: body.body,
          type: body.type ?? "announcement",
          channels,
          recipientCount,
          status: "queued",
          createdAt: nowIso(),
        };
        store.broadcasts.push(broadcast);
        // TODO(db): dispatch the queued BroadcastNotification job.
        return status(202, ok(`Broadcast queued for ${recipientCount} recipients.`, { broadcast }));
      }, { body: BroadcastBody })
  );
}

/** Default singleton plugin (uses the shared in-memory admin store). */
export const adminApp = createAdminPlugin();
