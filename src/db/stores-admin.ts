/**
 * Postgres-backed persistence overlays for the admin review queues.
 *
 * The single source of truth for behaviour is the in-memory AdminStore and
 * its queue adapters in src/modules/admin/index.ts:
 *  - AdvertsAdminQueue   -> adverts table (list / stats / publish / unpublish)
 *  - TicketsAdminQueue   -> support_tickets (list / assign)
 *  - BroadcastsAdminQueue-> notification_broadcasts + users (list / create /
 *                          recipient counts)
 *  - AdminLogStore       -> admin_logs (audit trail per mutating action)
 *
 * These factories implement the SAME public interfaces so the admin plugin
 * can swap queue sources at construction time without touching route code.
 * Tests keep passing explicit in-memory stores, so they stay on the memory
 * path regardless of DATABASE_URL.
 */

import { and, desc, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import { db } from "./client";
import {
  adverts,
  adminLogs,
  kycProfiles,
  kycStatusEnum,
  modelHasRoles,
  notificationBroadcasts,
  providerApplications,
  roles,
  sellerApplications,
  supportTickets,
  ticketPriorityEnum,
  ticketStatusEnum,
  users,
} from "./schema";
import { numericUserId, toIso } from "./stores-engagement";
import { nowIso } from "../utils/phone";

// Type-only imports — erased at runtime, so these factories never create a
// runtime cycle with the admin module that consumes them.
import type {
  AdminLogRow,
  AdminLogStoreLike,
  AdminManagedUser,
  AdvertItem,
  AdvertsAdminQueueLike,
  ApplicationItem,
  BroadcastItem,
  BroadcastsAdminQueueLike,
  KycAdminQueueLike,
  KycReviewItem,
  RoleApplicationsAdminQueueLike,
  SupportTicketItem,
  TicketsAdminQueueLike,
  UsersAdminQueueLike,
} from "../modules/admin/index";

/** spatie/laravel-permission model_type (matches seed data + auth UserStore). */
const MODEL_TYPE = "App\\Models\\User";

/** Guard enum columns so a bogus filter can't 500 on a Postgres enum. */
function validEnum(values: readonly string[], value: string | undefined): value is string {
  return value !== undefined && values.includes(value);
}

/** Role names for one user (spatie shape, same MODEL_TYPE as the auth UserStore). */
async function loadRoleNames(userId: number): Promise<string[]> {
  const rows = await db
    .select({ name: roles.name })
    .from(modelHasRoles)
    .innerJoin(roles, eq(modelHasRoles.roleId, roles.id))
    .where(and(eq(modelHasRoles.modelId, userId), eq(modelHasRoles.modelType, MODEL_TYPE)));
  return rows.map((r) => r.name);
}

/** Best-effort role grant (missing seed role, or any DB error, never throws). */
async function grantRoleName(userId: number, roleName: string): Promise<void> {
  try {
    const [role] = await db.select({ id: roles.id }).from(roles).where(eq(roles.name, roleName)).limit(1);
    if (!role) return;
    await db
      .insert(modelHasRoles)
      .values({ roleId: role.id, modelType: MODEL_TYPE, modelId: userId })
      .onConflictDoNothing();
  } catch (err) {
    console.warn("[admin:roles] grant failed", { userId, roleName, error: (err as Error).message });
  }
}

/** Best-effort role revoke (never throws). */
async function revokeRoleName(userId: number, roleName: string): Promise<void> {
  try {
    const [role] = await db.select({ id: roles.id }).from(roles).where(eq(roles.name, roleName)).limit(1);
    if (!role) return;
    await db
      .delete(modelHasRoles)
      .where(
        and(
          eq(modelHasRoles.modelId, userId),
          eq(modelHasRoles.modelType, MODEL_TYPE),
          eq(modelHasRoles.roleId, role.id),
        ),
      );
  } catch (err) {
    console.warn("[admin:roles] revoke failed", { userId, roleName, error: (err as Error).message });
  }
}

// ── admin_logs ────────────────────────────────────────────────────────────

/**
 * AdminStore audit-trail overlay: one `admin_logs` row per mutating admin
 * action. Writes are best-effort — a failure to persist the log must never
 * fail the admin action it describes.
 */
export function createDbAdminLogStore(): AdminLogStoreLike {
  type Row = typeof adminLogs.$inferSelect;

  function rowToRow(row: Row): AdminLogRow {
    return {
      id: row.id,
      adminId: String(row.adminId),
      action: row.action,
      targetType: row.targetType,
      targetId: row.targetId != null ? String(row.targetId) : null,
      details: (row.details as Record<string, unknown> | null) ?? null,
      createdAt: toIso(row.createdAt) ?? nowIso(),
    };
  }

  /** Fallback row for non-numeric admin ids / write failures (never throw). */
  function synthetic(entry: Parameters<AdminLogStoreLike["log"]>[0]): AdminLogRow {
    return {
      id: 0,
      adminId: entry.adminId,
      action: entry.action,
      targetType: entry.targetType ?? null,
      targetId: entry.targetId != null ? String(entry.targetId) : null,
      details: (entry.details as Record<string, unknown> | null) ?? null,
      createdAt: nowIso(),
    };
  }

  return {
    async log(entry) {
      const adminNum = numericUserId(entry.adminId);
      if (adminNum == null) {
        console.warn("[admin_logs] skipped (non-numeric admin id)", {
          admin_id: entry.adminId,
          action: entry.action,
        });
        return synthetic(entry);
      }
      try {
        const [row] = await db
          .insert(adminLogs)
          .values({
            adminId: adminNum,
            action: entry.action,
            targetType: entry.targetType ?? null,
            // target_id is a bigint column — non-numeric targets ride in details.
            targetId: numericUserId(entry.targetId) ?? null,
            details: entry.details ?? null,
          })
          .returning();
        if (!row) throw new Error("admin_logs insert returned no row");
        return rowToRow(row);
      } catch (err) {
        console.error("[admin_logs] write failed", {
          action: entry.action,
          error: (err as Error).message,
        });
        return synthetic(entry);
      }
    },

    /** No-op for parity: DB rows persist across requests (tests use memory). */
    reset(): void {},
  };
}

// ── Adverts review queue ──────────────────────────────────────────────────

/**
 * AdvertStore admin-queue overlay over the `adverts` table. Mirrors the
 * memory adapter exactly: list (newest first, optional status filter),
 * stats (counts + revenue), publish (active + published/expiry from
 * duration_days), unpublish.
 */
export function createDbAdvertsAdminQueue(): AdvertsAdminQueueLike {
  type Row = typeof adverts.$inferSelect;

  function rowToItem(row: Row): AdvertItem {
    return {
      id: String(row.id),
      userId: String(row.userId),
      title: row.title,
      status: row.status as AdvertItem["status"],
      durationDays: row.durationDays,
      amountPaid: Number(row.amountPaid),
      publishedAt: toIso(row.publishedAt),
      expiresAt: toIso(row.expiresAt),
      createdAt: toIso(row.createdAt) ?? nowIso(),
    };
  }

  return {
    async list(status) {
      const base = status
        ? db.select().from(adverts).where(eq(adverts.status, status))
        : db.select().from(adverts);
      const rows = await base.orderBy(desc(adverts.id));
      return rows.map(rowToItem);
    },

    async stats() {
      const rows = await db
        .select({ status: adverts.status, amount: adverts.amountPaid })
        .from(adverts);
      const out = { total: rows.length, active: 0, pending: 0, expired: 0, revenue: 0 };
      for (const row of rows) {
        if (row.status === "active") out.active++;
        else if (row.status === "pending") out.pending++;
        else if (row.status === "expired") out.expired++;
        out.revenue += Number(row.amount);
      }
      out.revenue = Math.round(out.revenue * 100) / 100;
      return out;
    },

    async publish(id) {
      const numeric = numericUserId(id);
      if (numeric == null) return null;
      const [current] = await db.select().from(adverts).where(eq(adverts.id, numeric)).limit(1);
      if (!current) return null;
      const now = new Date();
      const [row] = await db
        .update(adverts)
        .set({
          status: "active",
          publishedAt: now,
          expiresAt: new Date(now.getTime() + current.durationDays * 24 * 60 * 60 * 1000),
        })
        .where(eq(adverts.id, numeric))
        .returning();
      return row ? rowToItem(row) : null;
    },

    async unpublish(id) {
      const numeric = numericUserId(id);
      if (numeric == null) return null;
      const [row] = await db
        .update(adverts)
        .set({ status: "unpublished" })
        .where(eq(adverts.id, numeric))
        .returning();
      return row ? rowToItem(row) : null;
    },

    /** No-op for parity: DB rows persist across requests (tests use memory). */
    reset(): void {},
  };
}

// ── Support ticket review queue ───────────────────────────────────────────

/**
 * Support ticket admin-queue overlay over `support_tickets`. The queue only
 * reads listable fields + assignment (assigned_to); the full thread and
 * reply/status flows live in the support module's own store.
 */
export function createDbTicketsAdminQueue(): TicketsAdminQueueLike {
  type Row = typeof supportTickets.$inferSelect;

  function rowToItem(row: Row): SupportTicketItem {
    return {
      id: String(row.id),
      ticketNumber: row.ticketNumber,
      userId: String(row.userId),
      subject: row.subject,
      status: row.status,
      priority: row.priority,
      category: row.category,
      assignedTo: row.assignedTo != null ? String(row.assignedTo) : null,
      createdAt: toIso(row.createdAt) ?? nowIso(),
    };
  }

  return {
    async list(status, priority) {
      const filters: SQL[] = [];
      if (validEnum(ticketStatusEnum.enumValues as readonly string[], status)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        filters.push(eq(supportTickets.status, status as any));
      }
      if (validEnum(ticketPriorityEnum.enumValues as readonly string[], priority)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        filters.push(eq(supportTickets.priority, priority as any));
      }
      const base = filters.length > 0 ? db.select().from(supportTickets).where(and(...filters)) : db.select().from(supportTickets);
      const rows = await base.orderBy(desc(supportTickets.createdAt));
      return rows.map(rowToItem);
    },

    async get(id) {
      const numeric = numericUserId(id);
      if (numeric == null) return undefined;
      const [row] = await db.select().from(supportTickets).where(eq(supportTickets.id, numeric)).limit(1);
      return row ? rowToItem(row) : undefined;
    },

    async assign(ticket, agentId) {
      const numeric = numericUserId(ticket.id);
      const agentNum = numericUserId(agentId);
      if (numeric == null || agentNum == null) return ticket;
      const [row] = await db
        .update(supportTickets)
        .set({ assignedTo: agentNum })
        .where(eq(supportTickets.id, numeric))
        .returning();
      return row ? rowToItem(row) : ticket;
    },

    /** No-op for parity: DB rows persist across requests (tests use memory). */
    reset(): void {},
  };
}

// ── Notification broadcast queue ──────────────────────────────────────────

/**
 * Broadcast admin-queue overlay over `notification_broadcasts` (+ `users`
 * for recipient counts). `recipientCount` matches the memory adapter's
 * non-suspended semantics, joined through model_has_roles for the role
 * audience (spatie shape, same MODEL_TYPE as the auth UserStore).
 */
export function createDbBroadcastsAdminQueue(): BroadcastsAdminQueueLike {
  type Row = typeof notificationBroadcasts.$inferSelect;

  function rowToItem(row: Row): BroadcastItem {
    return {
      id: String(row.id),
      adminId: String(row.adminId),
      audience: row.audience,
      title: row.title,
      body: row.body,
      type: row.type,
      channels: (row.channels as string[] | null) ?? ["push"],
      recipientCount: row.recipientCount,
      status: row.status,
      createdAt: toIso(row.createdAt) ?? nowIso(),
    };
  }

  return {
    async list() {
      const rows = await db
        .select()
        .from(notificationBroadcasts)
        .orderBy(desc(notificationBroadcasts.createdAt));
      return rows.map(rowToItem);
    },

    async recipientCount(audience, role, state, userIds) {
      switch (audience) {
        case "role": {
          if (!role) return 0;
          const [row] = await db
            .select({ count: sql<number>`count(*)::int` })
            .from(users)
            .innerJoin(
              modelHasRoles,
              and(eq(modelHasRoles.modelId, users.id), eq(modelHasRoles.modelType, MODEL_TYPE)),
            )
            .innerJoin(roles, eq(modelHasRoles.roleId, roles.id))
            .where(and(eq(roles.name, role), eq(users.isSuspended, false)));
          return row?.count ?? 0;
        }
        case "state": {
          if (!state) return 0;
          const [row] = await db
            .select({ count: sql<number>`count(*)::int` })
            .from(users)
            .where(and(eq(users.locationState, state), eq(users.isSuspended, false)));
          return row?.count ?? 0;
        }
        case "users":
          return Math.min(userIds?.length ?? 0, 1000);
        default: {
          const [row] = await db
            .select({ count: sql<number>`count(*)::int` })
            .from(users)
            .where(eq(users.isSuspended, false));
          return row?.count ?? 0;
        }
      }
    },

    async create(item) {
      const adminNum = numericUserId(item.adminId);
      if (adminNum == null) {
        console.warn("[broadcasts] persist skipped (non-numeric admin id)", item.adminId);
        return item;
      }
      const [row] = await db
        .insert(notificationBroadcasts)
        .values({
          adminId: adminNum,
          audience: item.audience as typeof notificationBroadcasts.$inferInsert.audience,
          type: item.type,
          title: item.title,
          body: item.body,
          channels: item.channels,
          status: "queued",
          recipientCount: item.recipientCount,
        })
        .returning();
      return row ? rowToItem(row) : item;
    },

    /** No-op for parity: DB rows persist across requests (tests use memory). */
    reset(): void {},
  };
}
// ── KYC review queue ──────────────────────────────────────────────────────

/**
 * KYC review overlay over `kyc_profiles`. Mirrors the memory adapter:
 * list (newest first, optional status/tier filters), approve (status +
 * reviewer), reject (status + reason + reviewer).
 */
export function createDbKycAdminQueue(): KycAdminQueueLike {
  type Row = typeof kycProfiles.$inferSelect;

  function rowToItem(row: Row): KycReviewItem {
    return {
      id: String(row.id),
      userId: String(row.userId),
      tier: row.tier === 2 ? 2 : 1,
      status: (row.status ?? "pending") as KycReviewItem["status"],
      rejectionReason: row.rejectionReason,
      reviewedBy: row.reviewedBy != null ? String(row.reviewedBy) : null,
      reviewedAt: toIso(row.reviewedAt),
      createdAt: toIso(row.createdAt) ?? nowIso(),
    };
  }

  return {
    async list(status, tier) {
      const filters: SQL[] = [];
      if (validEnum(kycStatusEnum.enumValues as readonly string[], status)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        filters.push(eq(kycProfiles.status, status as any));
      }
      if (tier === 1 || tier === 2) {
        filters.push(eq(kycProfiles.tier, tier));
      }
      const base =
        filters.length > 0
          ? db.select().from(kycProfiles).where(and(...filters))
          : db.select().from(kycProfiles);
      const rows = await base.orderBy(desc(kycProfiles.createdAt));
      return rows.map(rowToItem);
    },

    async approve(id, reviewerId) {
      const numeric = numericUserId(id);
      if (numeric == null) return null;
      const [row] = await db
        .update(kycProfiles)
        .set({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          status: "approved" as any,
          rejectionReason: null,
          reviewedBy: numericUserId(reviewerId),
          reviewedAt: new Date(),
        })
        .where(eq(kycProfiles.id, numeric))
        .returning();
      return row ? rowToItem(row) : null;
    },

    async reject(id, reason, reviewerId) {
      const numeric = numericUserId(id);
      if (numeric == null) return null;
      const [row] = await db
        .update(kycProfiles)
        .set({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          status: "rejected" as any,
          rejectionReason: reason,
          reviewedBy: numericUserId(reviewerId),
          reviewedAt: new Date(),
        })
        .where(eq(kycProfiles.id, numeric))
        .returning();
      return row ? rowToItem(row) : null;
    },

    /** No-op for parity: DB rows persist across requests (tests use memory). */
    reset(): void {},
  };
}

// ── Seller / provider application review queues ───────────────────────────

/**
 * Role-application review overlay shared by `seller_applications` and
 * `provider_applications` (identical review columns). Approval also grants
 * the platform role via model_has_roles (best-effort); decline records the
 * reason. Mirrors the memory adapter including the role side effect.
 */
function createDbApplicationReviewQueue(
  table: typeof sellerApplications | typeof providerApplications,
  grantedRole: string,
): RoleApplicationsAdminQueueLike {
  type Row = {
    id: number;
    userId: number;
    status: string | null;
    declinedReason: string | null;
    reviewedBy: number | null;
    reviewedAt: Date | null;
    createdAt: Date | null;
  };

  function rowToItem(row: Row): ApplicationItem {
    return {
      id: String(row.id),
      userId: String(row.userId),
      status: (row.status ?? "pending") as ApplicationItem["status"],
      declinedReason: row.declinedReason,
      reviewedBy: row.reviewedBy != null ? String(row.reviewedBy) : null,
      reviewedAt: toIso(row.reviewedAt),
      createdAt: toIso(row.createdAt) ?? nowIso(),
    };
  }

  return {
    async list() {
      const rows = await db.select().from(table).orderBy(desc(table.createdAt));
      return rows.map(rowToItem);
    },

    async approve(id, reviewerId) {
      const numeric = numericUserId(id);
      if (numeric == null) return null;
      const [row] = await db
        .update(table)
        .set({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          status: "approved" as any,
          declinedReason: null,
          reviewedBy: numericUserId(reviewerId),
          reviewedAt: new Date(),
        })
        .where(eq(table.id, numeric))
        .returning();
      if (!row) return null;
      await grantRoleName(row.userId, grantedRole);
      return rowToItem(row);
    },

    async decline(id, reason, reviewerId) {
      const numeric = numericUserId(id);
      if (numeric == null) return null;
      const [row] = await db
        .update(table)
        .set({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          status: "declined" as any,
          declinedReason: reason,
          reviewedBy: numericUserId(reviewerId),
          reviewedAt: new Date(),
        })
        .where(eq(table.id, numeric))
        .returning();
      return row ? rowToItem(row) : null;
    },

    /** No-op for parity: DB rows persist across requests (tests use memory). */
    reset(): void {},
  };
}

/** Seller-application review queue (`seller_applications`, grants `seller`). */
export function createDbSellerApplicationsAdminQueue(): RoleApplicationsAdminQueueLike {
  return createDbApplicationReviewQueue(sellerApplications, "seller");
}

/** Provider-application review queue (`provider_applications`, grants `provider`). */
export function createDbProviderApplicationsAdminQueue(): RoleApplicationsAdminQueueLike {
  return createDbApplicationReviewQueue(providerApplications, "provider");
}

// ── Managed-users queue ───────────────────────────────────────────────────

/**
 * Managed-users overlay over `users` + `model_has_roles`. List supports the
 * same role/search filters as the memory adapter (roles resolved per user);
 * suspend/unsuspend and grant/revoke persist to the user row / role pivot.
 */
export function createDbUsersAdminQueue(): UsersAdminQueueLike {
  async function rowToUser(
    row: typeof users.$inferSelect,
    rolesByUser?: Map<number, string[]>,
  ): Promise<AdminManagedUser> {
    return {
      id: String(row.id),
      name: row.name,
      email: row.email,
      roles: rolesByUser?.get(row.id) ?? (await loadRoleNames(row.id)),
      state: row.locationState,
      isSuspended: row.isSuspended,
      suspensionReason: row.suspensionReason,
      createdAt: toIso(row.createdAt) ?? nowIso(),
    };
  }

  return {
    async list(role, search) {
      const needle = search?.trim();
      const filters: SQL[] = [];
      if (needle) {
        const pattern = `%${needle}%`;
        const emailMatch = ilike(users.email, pattern);
        const either = emailMatch
          ? or(ilike(users.name, pattern), emailMatch)
          : ilike(users.name, pattern);
        if (either) filters.push(either);
      }
      if (role) {
        const withRole = await db
          .select({ userId: modelHasRoles.modelId })
          .from(modelHasRoles)
          .innerJoin(roles, eq(modelHasRoles.roleId, roles.id))
          .where(and(eq(roles.name, role), eq(modelHasRoles.modelType, MODEL_TYPE)));
        const ids = withRole.map((r) => r.userId);
        if (ids.length === 0) return [];
        filters.push(inArray(users.id, ids));
      }
      const base =
        filters.length > 0
          ? db.select().from(users).where(and(...filters))
          : db.select().from(users);
      const rows = await base.orderBy(desc(users.createdAt));
      // One query for every listed user's roles (page-sized, not N+1).
      const rolesByUser = new Map<number, string[]>();
      if (rows.length > 0) {
        const roleRows = await db
          .select({ userId: modelHasRoles.modelId, name: roles.name })
          .from(modelHasRoles)
          .innerJoin(roles, eq(modelHasRoles.roleId, roles.id))
          .where(
            and(
              inArray(
                modelHasRoles.modelId,
                rows.map((r) => r.id),
              ),
              eq(modelHasRoles.modelType, MODEL_TYPE),
            ),
          );
        for (const r of roleRows) {
          const list = rolesByUser.get(r.userId) ?? [];
          list.push(r.name);
          rolesByUser.set(r.userId, list);
        }
      }
      return Promise.all(rows.map((row) => rowToUser(row, rolesByUser)));
    },

    async get(id) {
      const numeric = numericUserId(id);
      if (numeric == null) return undefined;
      const [row] = await db.select().from(users).where(eq(users.id, numeric)).limit(1);
      return row ? rowToUser(row) : undefined;
    },

    async suspend(id, reason) {
      const numeric = numericUserId(id);
      if (numeric == null) return null;
      const [row] = await db
        .update(users)
        .set({ isSuspended: true, suspensionReason: reason, suspendedAt: new Date() })
        .where(eq(users.id, numeric))
        .returning();
      return row ? rowToUser(row) : null;
    },

    async unsuspend(id) {
      const numeric = numericUserId(id);
      if (numeric == null) return null;
      const [row] = await db
        .update(users)
        .set({ isSuspended: false, suspensionReason: null })
        .where(eq(users.id, numeric))
        .returning();
      return row ? rowToUser(row) : null;
    },

    async grantRole(id, roleName) {
      const numeric = numericUserId(id);
      if (numeric == null) return null;
      const [row] = await db.select().from(users).where(eq(users.id, numeric)).limit(1);
      if (!row) return null;
      await grantRoleName(numeric, roleName);
      return rowToUser(row);
    },

    async revokeRole(id, roleName) {
      const numeric = numericUserId(id);
      if (numeric == null) return null;
      const [row] = await db.select().from(users).where(eq(users.id, numeric)).limit(1);
      if (!row) return null;
      await revokeRoleName(numeric, roleName);
      return rowToUser(row);
    },

    /** No-op for parity: DB rows persist across requests (tests use memory). */
    reset(): void {},
  };
}
