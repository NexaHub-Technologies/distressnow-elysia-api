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

import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import { db } from "./client";
import {
  adverts,
  adminLogs,
  modelHasRoles,
  notificationBroadcasts,
  roles,
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
  AdvertItem,
  AdvertsAdminQueueLike,
  BroadcastItem,
  BroadcastsAdminQueueLike,
  SupportTicketItem,
  TicketsAdminQueueLike,
} from "../modules/admin/index";

/** spatie/laravel-permission model_type (matches seed data + auth UserStore). */
const MODEL_TYPE = "App\\Models\\User";

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

  /** Guard enum columns so a bogus filter can't 500 on a Postgres enum. */
  function validEnum(values: readonly string[], value: string | undefined): value is string {
    return value !== undefined && values.includes(value);
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