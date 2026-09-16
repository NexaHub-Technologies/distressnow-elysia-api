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
 * DB-backed review queues live in src/db/stores-admin.ts and are selected
 * when no explicit store is injected AND DATABASE_URL is reachable (users,
 * kyc_profiles, seller_applications, provider_applications, support_tickets,
 * adverts, notification_broadcasts, admin_logs). Every mutating action
 * records an admin_logs row.
 * TODO(db): back the remaining collections with drizzle (markets, listings,
 * contact_updates).
 */
import { Elysia, t } from "elysia";
import { applyAuthGuard, type UserStore } from "../auth/index";
import { dbModeActive, getDbStores } from "../../db/stores";
import {
  createDbAdvertsAdminQueue,
  createDbBroadcastsAdminQueue,
  createDbKycAdminQueue,
  createDbProviderApplicationsAdminQueue,
  createDbSellerApplicationsAdminQueue,
  createDbTicketsAdminQueue,
  createDbUsersAdminQueue,
} from "../../db/stores-admin";
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

// ── Admin audit log ─────────────────────────────────────────────────────────

export interface AdminLogRow {
  id: number;
  adminId: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  details: Record<string, unknown> | null;
  createdAt: string;
}

export interface AdminLogInput {
  adminId: string;
  action: string;
  targetType?: string | null;
  targetId?: string | number | null;
  details?: Record<string, unknown> | null;
}

export class MemoryAdminLogStore {
  rows: AdminLogRow[] = [];
  private seq = 1;

  reset(): void {
    this.rows = [];
    this.seq = 1;
  }

  log(entry: AdminLogInput): AdminLogRow {
    const row: AdminLogRow = {
      id: this.seq++,
      adminId: entry.adminId,
      action: entry.action,
      targetType: entry.targetType ?? null,
      targetId: entry.targetId != null ? String(entry.targetId) : null,
      details: entry.details ?? null,
      createdAt: nowIso(),
    };
    this.rows.push(row);
    return row;
  }
}

/** The in-memory sync log store (tests stay on it regardless of DATABASE_URL). */
export const adminLogStore = new MemoryAdminLogStore();

/**
 * Store surface consumed by the admin handlers. Widened to `T | Promise<T>`
 * so the DB-backed overlay (createDbAdminLogStore) implements the same shape;
 * handlers uniformly `await`.
 */
export interface AdminLogStoreLike {
  log(entry: AdminLogInput): AdminLogRow | Promise<AdminLogRow>;
  reset(): void | Promise<void>;
}

// ── Admin review queue seams ────────────────────────────────────────────────

export interface AdvertsAdminQueueStats {
  total: number;
  active: number;
  pending: number;
  expired: number;
  revenue: number;
}

export interface AdvertsAdminQueueLike {
  list(status?: string): AdvertItem[] | Promise<AdvertItem[]>;
  stats(): AdvertsAdminQueueStats | Promise<AdvertsAdminQueueStats>;
  publish(id: string): AdvertItem | null | Promise<AdvertItem | null>;
  unpublish(id: string): AdvertItem | null | Promise<AdvertItem | null>;
  reset(): void | Promise<void>;
}

export interface TicketsAdminQueueLike {
  list(status?: string, priority?: string): SupportTicketItem[] | Promise<SupportTicketItem[]>;
  get(id: string): SupportTicketItem | undefined | Promise<SupportTicketItem | undefined>;
  assign(ticket: SupportTicketItem, agentId: string): SupportTicketItem | Promise<SupportTicketItem>;
  reset(): void | Promise<void>;
}

export interface BroadcastsAdminQueueLike {
  list(): BroadcastItem[] | Promise<BroadcastItem[]>;
  recipientCount(
    audience: string,
    role?: string,
    state?: string,
    userIds?: string[],
  ): number | Promise<number>;
  create(item: BroadcastItem): BroadcastItem | Promise<BroadcastItem>;
  reset(): void | Promise<void>;
}

/**
 * Memory queue adapters over an AdminStore's collections. The admin tests
 * assert on the shared maps/arrays after mutations (`store.adverts.get(...)`,
 * `store.tickets.get(...)`, `store.broadcasts.length`), so these mutate in
 * place exactly like the old inline handlers.
 */
export class MemoryAdvertsAdminQueue implements AdvertsAdminQueueLike {
  constructor(readonly adverts: Map<string, AdvertItem>) {}

  list(status?: string): AdvertItem[] {
    return [...this.adverts.values()]
      .filter((advert) => !status || advert.status === status)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  stats(): AdvertsAdminQueueStats {
    const adverts = [...this.adverts.values()];
    return {
      total: adverts.length,
      active: adverts.filter((advert) => advert.status === "active").length,
      pending: adverts.filter((advert) => advert.status === "pending").length,
      expired: adverts.filter((advert) => advert.status === "expired").length,
      revenue: adverts.reduce((sum, advert) => sum + advert.amountPaid, 0),
    };
  }

  publish(id: string): AdvertItem | null {
    const advert = this.adverts.get(id);
    if (!advert) return null;
    const now = new Date();
    advert.status = "active";
    advert.publishedAt = now.toISOString();
    advert.expiresAt = new Date(
      now.getTime() + advert.durationDays * 24 * 60 * 60 * 1000,
    ).toISOString();
    return advert;
  }

  unpublish(id: string): AdvertItem | null {
    const advert = this.adverts.get(id);
    if (!advert) return null;
    advert.status = "unpublished";
    return advert;
  }

  reset(): void {}
}

export class MemoryTicketsAdminQueue implements TicketsAdminQueueLike {
  constructor(readonly tickets: Map<string, SupportTicketItem>) {}

  list(status?: string, priority?: string): SupportTicketItem[] {
    return [...this.tickets.values()]
      .filter((ticket) => !status || ticket.status === status)
      .filter((ticket) => !priority || ticket.priority === priority)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id: string): SupportTicketItem | undefined {
    return this.tickets.get(id);
  }

  assign(ticket: SupportTicketItem, agentId: string): SupportTicketItem {
    // In-place mutation: the caller holds the shared map entry, so
    // `store.tickets.get(id)?.assignedTo` reflects the assignment.
    ticket.assignedTo = agentId;
    return ticket;
  }

  reset(): void {}
}

export class MemoryBroadcastsAdminQueue implements BroadcastsAdminQueueLike {
  constructor(readonly store: AdminStore) {}

  list(): BroadcastItem[] {
    return [...this.store.broadcasts].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  recipientCount(audience: string, role?: string, state?: string, userIds?: string[]): number {
    return this.store.recipientCount(audience, role, state, userIds);
  }

  create(item: BroadcastItem): BroadcastItem {
    this.store.broadcasts.push(item);
    return item;
  }

  reset(): void {}
}

// ── Admin identity queue seams (users / KYC / role applications) ───────────

export interface KycAdminQueueLike {
  list(status?: string, tier?: number): KycReviewItem[] | Promise<KycReviewItem[]>;
  approve(id: string, reviewerId: string): KycReviewItem | null | Promise<KycReviewItem | null>;
  reject(
    id: string,
    reason: string,
    reviewerId: string,
  ): KycReviewItem | null | Promise<KycReviewItem | null>;
  reset(): void | Promise<void>;
}

export interface RoleApplicationsAdminQueueLike {
  list(): ApplicationItem[] | Promise<ApplicationItem[]>;
  approve(id: string, reviewerId: string): ApplicationItem | null | Promise<ApplicationItem | null>;
  decline(
    id: string,
    reason: string,
    reviewerId: string,
  ): ApplicationItem | null | Promise<ApplicationItem | null>;
  reset(): void | Promise<void>;
}

export interface UsersAdminQueueLike {
  list(role?: string, search?: string): AdminManagedUser[] | Promise<AdminManagedUser[]>;
  get(id: string): AdminManagedUser | undefined | Promise<AdminManagedUser | undefined>;
  suspend(id: string, reason: string): AdminManagedUser | null | Promise<AdminManagedUser | null>;
  unsuspend(id: string): AdminManagedUser | null | Promise<AdminManagedUser | null>;
  grantRole(id: string, role: string): AdminManagedUser | null | Promise<AdminManagedUser | null>;
  revokeRole(id: string, role: string): AdminManagedUser | null | Promise<AdminManagedUser | null>;
  reset(): void | Promise<void>;
}

/**
 * Memory identity adapters over an AdminStore's collections. Mutations hit
 * the shared maps in place so test assertions on `store.kyc`,
 * `store.sellerApps` / `store.providerApps` (incl. the role grant on
 * `store.users`) and `store.users` stay green.
 */
export class MemoryKycAdminQueue implements KycAdminQueueLike {
  constructor(readonly kyc: Map<string, KycReviewItem>) {}

  list(status?: string, tier?: number): KycReviewItem[] {
    return [...this.kyc.values()]
      .filter((item) => !status || item.status === status)
      .filter((item) => tier === undefined || item.tier === tier)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  approve(id: string, reviewerId: string): KycReviewItem | null {
    const item = this.kyc.get(id);
    if (!item) return null;
    item.status = "approved";
    item.rejectionReason = null;
    item.reviewedBy = reviewerId;
    item.reviewedAt = nowIso();
    return item;
  }

  reject(id: string, reason: string, reviewerId: string): KycReviewItem | null {
    const item = this.kyc.get(id);
    if (!item) return null;
    item.status = "rejected";
    item.rejectionReason = reason;
    item.reviewedBy = reviewerId;
    item.reviewedAt = nowIso();
    return item;
  }

  reset(): void {}
}

/**
 * Memory role-application adapter. Approval also grants the platform role
 * on the shared users map (mirrors the old inline handler).
 */
export class MemoryRoleApplicationsAdminQueue implements RoleApplicationsAdminQueueLike {
  constructor(
    readonly apps: Map<string, ApplicationItem>,
    readonly users: Map<string, AdminManagedUser>,
    readonly grantedRole: string,
  ) {}

  list(): ApplicationItem[] {
    return [...this.apps.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  approve(id: string, reviewerId: string): ApplicationItem | null {
    const app = this.apps.get(id);
    if (!app) return null;
    app.status = "approved";
    app.reviewedBy = reviewerId;
    app.reviewedAt = nowIso();
    const user = this.users.get(app.userId);
    if (user && !user.roles.includes(this.grantedRole)) user.roles.push(this.grantedRole);
    return app;
  }

  decline(id: string, reason: string, reviewerId: string): ApplicationItem | null {
    const app = this.apps.get(id);
    if (!app) return null;
    app.status = "declined";
    app.declinedReason = reason;
    app.reviewedBy = reviewerId;
    app.reviewedAt = nowIso();
    return app;
  }

  reset(): void {}
}

export class MemoryUsersAdminQueue implements UsersAdminQueueLike {
  constructor(readonly users: Map<string, AdminManagedUser>) {}

  list(role?: string, search?: string): AdminManagedUser[] {
    const needle = search?.toLowerCase();
    return [...this.users.values()]
      .filter((user) => !role || user.roles.includes(role))
      .filter(
        (user) =>
          !needle ||
          user.name.toLowerCase().includes(needle) ||
          (user.email ?? "").toLowerCase().includes(needle),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id: string): AdminManagedUser | undefined {
    return this.users.get(id);
  }

  suspend(id: string, reason: string): AdminManagedUser | null {
    const user = this.users.get(id);
    if (!user) return null;
    user.isSuspended = true;
    user.suspensionReason = reason;
    return user;
  }

  unsuspend(id: string): AdminManagedUser | null {
    const user = this.users.get(id);
    if (!user) return null;
    user.isSuspended = false;
    user.suspensionReason = null;
    return user;
  }

  grantRole(id: string, role: string): AdminManagedUser | null {
    const user = this.users.get(id);
    if (!user) return null;
    if (!user.roles.includes(role)) user.roles.push(role);
    return user;
  }

  revokeRole(id: string, role: string): AdminManagedUser | null {
    const user = this.users.get(id);
    if (!user) return null;
    user.roles = user.roles.filter((r) => r !== role);
    return user;
  }

  reset(): void {}
}

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
  /** Audit-trail store (memory default; DB-backed `admin_logs` in production). */
  logs?: AdminLogStoreLike;
  /** Adverts review queue (memory AdminStore map by default; `adverts` table in production). */
  advertsQueue?: AdvertsAdminQueueLike;
  /** Support ticket review queue (memory AdminStore map by default; `support_tickets` in production). */
  ticketsQueue?: TicketsAdminQueueLike;
  /** Broadcast queue (memory AdminStore array by default; `notification_broadcasts` in production). */
  broadcastsQueue?: BroadcastsAdminQueueLike;
  /** KYC review queue (memory AdminStore map by default; `kyc_profiles` in production). */
  kycQueue?: KycAdminQueueLike;
  /** Seller-application review queue (memory map by default; `seller_applications` in production). */
  sellersQueue?: RoleApplicationsAdminQueueLike;
  /** Provider-application review queue (memory map by default; `provider_applications` in production). */
  providersQueue?: RoleApplicationsAdminQueueLike;
  /** Managed-users queue (memory AdminStore map by default; `users` in production). */
  usersQueue?: UsersAdminQueueLike;
}

const STAFF = "admin|verifier";

export function createAdminPlugin(options: AdminPluginOptions = {}) {
  const store = options.store ?? adminStore;
  // DB-backed queues/log only when no explicit in-memory AdminStore was
  // injected (tests always pass one, so they stay on the memory path).
  const db = dbModeActive() && options.store === undefined ? getDbStores() : null;

  const advertsQueue =
    options.advertsQueue ?? (db ? createDbAdvertsAdminQueue() : new MemoryAdvertsAdminQueue(store.adverts));
  const ticketsQueue =
    options.ticketsQueue ?? (db ? createDbTicketsAdminQueue() : new MemoryTicketsAdminQueue(store.tickets));
  const broadcastsQueue =
    options.broadcastsQueue ?? (db ? createDbBroadcastsAdminQueue() : new MemoryBroadcastsAdminQueue(store));
  const kycQueue =
    options.kycQueue ?? (db ? createDbKycAdminQueue() : new MemoryKycAdminQueue(store.kyc));
  const sellersQueue =
    options.sellersQueue ??
    (db
      ? createDbSellerApplicationsAdminQueue()
      : new MemoryRoleApplicationsAdminQueue(store.sellerApps, store.users, "seller"));
  const providersQueue =
    options.providersQueue ??
    (db
      ? createDbProviderApplicationsAdminQueue()
      : new MemoryRoleApplicationsAdminQueue(store.providerApps, store.users, "provider"));
  const usersQueue =
    options.usersQueue ?? (db ? createDbUsersAdminQueue() : new MemoryUsersAdminQueue(store.users));
  const logs = options.logs ?? (db ? db.adminLogs : adminLogStore);

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
      .get("/kyc", async ({ staff, headers, status, query }) => {
        const denied = staffAccessError(staff, STAFF);
        if (denied) return status(denied.status, fail(denied.message));
        const items = await kycQueue.list(query.status, query.tier);
        const { data, meta } = paginate(items, query.page ?? 1, query.per_page ?? 20);
        return ok("KYC submissions retrieved.", data, meta);
      }, { query: KycQuery })
      .post("/kyc/:id/approve", async ({ staff, headers, status, params }) => {
        const denied = staffAccessError(staff, STAFF);
        if (denied) return status(denied.status, fail(denied.message));
        const item = await kycQueue.approve(params.id, (staff as StaffUser).id);
        if (!item) return status(404, fail("KYC submission not found."));
        await logs.log({
          adminId: (staff as StaffUser).id,
          action: "kyc.approved",
          targetType: "kyc_submission",
          targetId: item.id,
          details: { tier: item.tier, userId: item.userId },
        });
        // TODO(db): notify the user (kyc_approval) via NotificationService port.
        return ok(`KYC #${item.id} approved. User can now apply for roles.`, {
          id: item.id,
          tier: item.tier,
          status: item.status,
        });
      })
      .post("/kyc/:id/reject", async ({ staff, headers, status, params, body }) => {
        const denied = staffAccessError(staff, STAFF);
        if (denied) return status(denied.status, fail(denied.message));
        const item = await kycQueue.reject(params.id, body.reason, (staff as StaffUser).id);
        if (!item) return status(404, fail("KYC submission not found."));
        await logs.log({
          adminId: (staff as StaffUser).id,
          action: "kyc.rejected",
          targetType: "kyc_submission",
          targetId: item.id,
          details: { tier: item.tier, userId: item.userId, reason: body.reason },
        });
        return ok(`KYC #${item.id} rejected.`, { id: item.id, reason: body.reason });
      }, { body: ReasonBody })

      // ── Role applications ──────────────────────────────────────────
      .get("/applications/sellers", async ({ staff, headers, status, query }) => {
        const denied = staffAccessError(staff, STAFF);
        if (denied) return status(denied.status, fail(denied.message));
        const items = await sellersQueue.list();
        const { data, meta } = paginate(items, query.page ?? 1, query.per_page ?? 20);
        return ok("Seller applications retrieved.", data, meta);
      }, { query: PaginationQuery })
      .post("/applications/sellers/:id/approve", async ({ staff, headers, status, params }) => {
        const denied = staffAccessError(staff, STAFF);
        if (denied) return status(denied.status, fail(denied.message));
        const app = await sellersQueue.approve(params.id, (staff as StaffUser).id);
        if (!app) return status(404, fail("Seller application not found."));
        await logs.log({
          adminId: (staff as StaffUser).id,
          action: "seller_application.approved",
          targetType: "seller_application",
          targetId: app.id,
          details: { userId: app.userId },
        });
        return ok("Seller application approved.", { id: app.id, status: app.status });
      })
      .post("/applications/sellers/:id/decline", async ({ staff, headers, status, params, body }) => {
        const denied = staffAccessError(staff, STAFF);
        if (denied) return status(denied.status, fail(denied.message));
        const app = await sellersQueue.decline(params.id, body.reason, (staff as StaffUser).id);
        if (!app) return status(404, fail("Seller application not found."));
        await logs.log({
          adminId: (staff as StaffUser).id,
          action: "seller_application.declined",
          targetType: "seller_application",
          targetId: app.id,
          details: { userId: app.userId, reason: body.reason },
        });
        return ok("Seller application declined.", { id: app.id });
      }, { body: ReasonBody })
      .get("/applications/providers", async ({ staff, headers, status, query }) => {
        const denied = staffAccessError(staff, STAFF);
        if (denied) return status(denied.status, fail(denied.message));
        const items = await providersQueue.list();
        const { data, meta } = paginate(items, query.page ?? 1, query.per_page ?? 20);
        return ok("Provider applications retrieved.", data, meta);
      }, { query: PaginationQuery })
      .post("/applications/providers/:id/approve", async ({ staff, headers, status, params }) => {
        const denied = staffAccessError(staff, STAFF);
        if (denied) return status(denied.status, fail(denied.message));
        const app = await providersQueue.approve(params.id, (staff as StaffUser).id);
        if (!app) return status(404, fail("Provider application not found."));
        await logs.log({
          adminId: (staff as StaffUser).id,
          action: "provider_application.approved",
          targetType: "provider_application",
          targetId: app.id,
          details: { userId: app.userId },
        });
        return ok("Provider application approved.", { id: app.id, status: app.status });
      })
      .post("/applications/providers/:id/decline", async ({ staff, headers, status, params, body }) => {
        const denied = staffAccessError(staff, STAFF);
        if (denied) return status(denied.status, fail(denied.message));
        const app = await providersQueue.decline(params.id, body.reason, (staff as StaffUser).id);
        if (!app) return status(404, fail("Provider application not found."));
        await logs.log({
          adminId: (staff as StaffUser).id,
          action: "provider_application.declined",
          targetType: "provider_application",
          targetId: app.id,
          details: { userId: app.userId, reason: body.reason },
        });
        return ok("Provider application declined.", { id: app.id });
      }, { body: ReasonBody })

      // ── User management ────────────────────────────────────────────
      .get("/users", async ({ staff, headers, status, query }) => {
        const denied = staffAccessError(staff, STAFF);
        if (denied) return status(denied.status, fail(denied.message));
        const items = (await usersQueue.list(query.role, query.search)).map(serializeUser);
        const { data, meta } = paginate(items, query.page ?? 1, query.per_page ?? 25);
        return ok("Users retrieved.", data, meta);
      }, { query: UsersQuery })
      .post("/users/:id/suspend", async ({ staff, headers, status, params, body }) => {
        const denied = staffAccessError(staff, "admin");
        if (denied) return status(denied.status, fail(denied.message));
        const user = await usersQueue.suspend(params.id, body.reason);
        if (!user) return status(404, fail("User not found."));
        // TODO(db): revoke the user's API tokens so suspension logs them out.
        await logs.log({
          adminId: (staff as StaffUser).id,
          action: "user.suspended",
          targetType: "user",
          targetId: user.id,
          details: { name: user.name, reason: body.reason },
        });
        return ok(`User [${user.name}] has been suspended.`, serializeUser(user));
      }, { body: ReasonBody })
      .post("/users/:id/unsuspend", async ({ staff, headers, status, params }) => {
        const denied = staffAccessError(staff, "admin");
        if (denied) return status(denied.status, fail(denied.message));
        const user = await usersQueue.unsuspend(params.id);
        if (!user) return status(404, fail("User not found."));
        await logs.log({
          adminId: (staff as StaffUser).id,
          action: "user.unsuspended",
          targetType: "user",
          targetId: user.id,
          details: { name: user.name },
        });
        return ok(`User [${user.name}] has been unsuspended.`, serializeUser(user));
      })
      .post("/users/:id/assign-role", async ({ staff, headers, status, params, body }) => {
        const denied = staffAccessError(staff, "admin");
        if (denied) return status(denied.status, fail(denied.message));
        if (body.action === "grant") {
          const user = await usersQueue.grantRole(params.id, body.role);
          if (!user) return status(404, fail("User not found."));
          await logs.log({
            adminId: (staff as StaffUser).id,
            action: "user.role_granted",
            targetType: "user",
            targetId: user.id,
            details: { name: user.name, role: body.role },
          });
          return ok(`Role '${body.role}' granted to [${user.name}].`, serializeUser(user));
        }
        const user = await usersQueue.revokeRole(params.id, body.role);
        if (!user) return status(404, fail("User not found."));
        await logs.log({
          adminId: (staff as StaffUser).id,
          action: "user.role_revoked",
          targetType: "user",
          targetId: user.id,
          details: { name: user.name, role: body.role },
        });
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
      .post("/markets", async ({ staff, headers, body, status }) => {
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
        await logs.log({
          adminId: (staff as StaffUser).id,
          action: "market.created",
          targetType: "market",
          targetId: market.id,
          details: { name: market.name, stateId: market.stateId },
        });
        return status(201, ok("Market created successfully.", serializeMarket(market)));
      }, { body: MarketBody })
      .put("/markets/:id", async ({ staff, headers, status, params, body }) => {
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
        await logs.log({
          adminId: (staff as StaffUser).id,
          action: "market.updated",
          targetType: "market",
          targetId: market.id,
          details: { name: market.name },
        });
        return ok("Market updated.", serializeMarket(market));
      }, { body: MarketUpdateBody })
      .delete("/markets/:id", async ({ staff, headers, status, params }) => {
        const denied = staffAccessError(staff, STAFF);
        if (denied) return status(denied.status, fail(denied.message));
        if (!store.markets.delete(params.id)) return status(404, fail("Market not found."));
        await logs.log({
          adminId: (staff as StaffUser).id,
          action: "market.deleted",
          targetType: "market",
          targetId: params.id,
        });
        return ok("Market deleted successfully.", null);
      })

      // ── Support queue ──────────────────────────────────────────────
      .get("/support/tickets", async ({ staff, headers, status, query }) => {
        const denied = staffAccessError(staff, STAFF);
        if (denied) return status(denied.status, fail(denied.message));
        const items = await ticketsQueue.list(query.status, query.priority);
        const { data, meta } = paginate(items, query.page ?? 1, query.per_page ?? 20);
        return ok("Support tickets retrieved.", data, meta);
      }, { query: t.Object({
        status: t.Optional(t.String({ maxLength: 32 })),
        priority: t.Optional(t.String({ maxLength: 32 })),
        page: t.Optional(t.Numeric({ minimum: 1 })),
        per_page: t.Optional(t.Numeric({ minimum: 1, maximum: 100 })),
      }) })
      .post("/support/tickets/:id/assign", async ({ staff, headers, status, params, body }) => {
        const denied = staffAccessError(staff, STAFF);
        if (denied) return status(denied.status, fail(denied.message));
        const ticket = await ticketsQueue.get(params.id);
        if (!ticket) return status(404, fail("Support ticket not found."));
        const agentId = body.agent_id ?? (staff as StaffUser).id;
        const agent = store.users.get(agentId);
        if (agent && !hasRequiredRole(agent.roles, STAFF)) {
          return status(422, fail("Tickets can only be assigned to an admin or verifier."));
        }
        const assigned = await ticketsQueue.assign(ticket, agentId);
        await logs.log({
          adminId: (staff as StaffUser).id,
          action: "support_ticket.assigned",
          targetType: "support_ticket",
          targetId: ticket.id,
          details: { ticketNumber: ticket.ticketNumber, agentId },
        });
        return ok(`Ticket ${assigned.ticketNumber} assigned.`, assigned);
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
      .post("/contact-updates/:id/approve", async ({ staff, headers, status, params }) => {
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
        await logs.log({
          adminId: (staff as StaffUser).id,
          action: "contact_update.approved",
          targetType: "contact_update",
          targetId: item.id,
          details: { providerId: item.providerId },
        });
        return ok("Contact update approved and applied.", item);
      })
      .post("/contact-updates/:id/reject", async ({ staff, headers, status, params }) => {
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
        await logs.log({
          adminId: (staff as StaffUser).id,
          action: "contact_update.rejected",
          targetType: "contact_update",
          targetId: item.id,
          details: { providerId: item.providerId },
        });
        return ok("Contact update rejected.", item);
      })

      // ── Adverts ────────────────────────────────────────────────────
      .get("/adverts", async ({ staff, headers, status, query }) => {
        const denied = staffAccessError(staff, STAFF);
        if (denied) return status(denied.status, fail(denied.message));
        const items = await advertsQueue.list(query.status);
        const { data, meta } = paginate(items, query.page ?? 1, query.per_page ?? 20);
        return ok("Adverts retrieved.", data, meta);
      }, { query: AdvertsQuery })
      .get("/adverts/stats", async ({ staff, headers, status }) => {
        const denied = staffAccessError(staff, STAFF);
        if (denied) return status(denied.status, fail(denied.message));
        return ok("Advert stats retrieved.", await advertsQueue.stats());
      })
      .post("/adverts/:id/publish", async ({ staff, headers, status, params }) => {
        const denied = staffAccessError(staff, STAFF);
        if (denied) return status(denied.status, fail(denied.message));
        const advert = await advertsQueue.publish(params.id);
        if (!advert) return status(404, fail("Advert not found."));
        await logs.log({
          adminId: (staff as StaffUser).id,
          action: "advert.published",
          targetType: "advert",
          targetId: advert.id,
          details: { title: advert.title, durationDays: advert.durationDays },
        });
        return ok("Advert published.", advert);
      })
      .post("/adverts/:id/unpublish", async ({ staff, headers, status, params }) => {
        const denied = staffAccessError(staff, STAFF);
        if (denied) return status(denied.status, fail(denied.message));
        const advert = await advertsQueue.unpublish(params.id);
        if (!advert) return status(404, fail("Advert not found."));
        await logs.log({
          adminId: (staff as StaffUser).id,
          action: "advert.unpublished",
          targetType: "advert",
          targetId: advert.id,
          details: { title: advert.title },
        });
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
      .post("/listings/:id/approve", async ({ staff, headers, status, params }) => {
        const denied = staffAccessError(staff, STAFF);
        if (denied) return status(denied.status, fail(denied.message));
        const listing = store.listings.get(params.id);
        if (!listing) return status(404, fail("Listing not found."));
        listing.approved = true;
        listing.status = "active";
        await logs.log({
          adminId: (staff as StaffUser).id,
          action: "listing.approved",
          targetType: "listing",
          targetId: listing.id,
          details: { title: listing.title },
        });
        return ok(`Listing "${listing.title}" approved and is now live.`, listing);
      })
      .post("/listings/:id/reject", async ({ staff, headers, status, params, body }) => {
        const denied = staffAccessError(staff, STAFF);
        if (denied) return status(denied.status, fail(denied.message));
        const listing = store.listings.get(params.id);
        if (!listing) return status(404, fail("Listing not found."));
        listing.approved = false;
        listing.status = "inactive";
        await logs.log({
          adminId: (staff as StaffUser).id,
          action: "listing.rejected",
          targetType: "listing",
          targetId: listing.id,
          details: { title: listing.title, reason: body.reason },
        });
        return ok(`Listing "${listing.title}" rejected.`, listing);
      }, { body: ReasonBody })
      .post("/listings/:id/feature", async ({ staff, headers, status, params, body }) => {
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
        await logs.log({
          adminId: (staff as StaffUser).id,
          action: featured ? "listing.featured" : "listing.unfeatured",
          targetType: "listing",
          targetId: listing.id,
          details: { title: listing.title, days: body.days ?? 7 },
        });
        return ok(
          featured ? "Listing featured." : "Listing removed from featured.",
          listing,
        );
      }, { body: FeatureBody })

      // ── Notification broadcasts (admin only, throttled) ────────────
      .get("/notifications/broadcasts", async ({ staff, headers, status, query }) => {
        const denied = staffAccessError(staff, "admin");
        if (denied) return status(denied.status, fail(denied.message));
        const items = await broadcastsQueue.list();
        const { data, meta } = paginate(items, query.page ?? 1, query.per_page ?? 20);
        return ok("Broadcasts retrieved.", { broadcasts: data }, meta);
      }, { query: PaginationQuery })
      .post("/notifications/broadcast", async ({ staff, headers, body, status }) => {
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

        const recipientCount = await broadcastsQueue.recipientCount(
          audience,
          body.role,
          body.state,
          body.user_ids,
        );
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
        await broadcastsQueue.create(broadcast);
        await logs.log({
          adminId,
          action: "broadcast.queued",
          targetType: "broadcast",
          targetId: broadcast.id,
          details: { audience, recipientCount, channels, type: broadcast.type },
        });
        // TODO(db): dispatch the queued BroadcastNotification job.
        return status(202, ok(`Broadcast queued for ${recipientCount} recipients.`, { broadcast }));
      }, { body: BroadcastBody })
  );
}

/** Default singleton plugin (uses the shared in-memory admin store). */
export const adminApp = createAdminPlugin();
