// src/modules/notifications/index.ts
//
// Notification centre + Expo push token registry.
//
// Mirrors DistressNowApi's NotificationController: paginated feed with an
// account-wide unread_count (not per-page, so the badge stays correct while
// paging), scoped single/all read, and token register/delete keyed on the
// token globally (a handset handed to another account is reassigned).
//
// Endpoints (mounted under /notifications):
//   GET    /notifications               paginated feed
//   POST   /notifications/push-token    register { token|device_token, platform }
//   DELETE /notifications/push-token    remove (logout)
//   POST   /notifications/read-all      mark all read (before /:id/read)
//   POST   /notifications/:id/read      mark one read (scoped → 404)

import { Elysia, t } from "elysia";
import { pgTable, serial, integer, varchar, text, timestamp, jsonb } from "drizzle-orm/pg-core";
import { DeviceTokenStore, sendPush } from "../../services/push";

// ── Drizzle contract (Postgres wiring seam; runtime uses in-memory store) ──

export const notifications = pgTable("notifications", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  type: varchar("type", { length: 60 }).notNull(),
  title: varchar("title", { length: 255 }).notNull(),
  body: text("body").notNull(),
  data: jsonb("data"),
  readAt: timestamp("read_at"),
  pushedAt: timestamp("pushed_at"),
  createdAt: timestamp("created_at").defaultNow(),
});

// ── Types ──────────────────────────────────────────────────────────────────

export interface NotificationRow {
  id: number;
  userId: number;
  type: string;
  title: string;
  body: string;
  data: Record<string, unknown> | null;
  readAt: string | null;
  createdAt: string;
}

export interface AuthUser {
  id: number;
  name: string;
  roles: string[];
}

function resolveUser(headers: Record<string, string | undefined>): AuthUser {
  const id = Number(headers["x-user-id"] ?? "1");
  const role = headers["x-user-role"];
  return {
    id: Number.isFinite(id) && id > 0 ? id : 1,
    name: headers["x-user-name"] ?? "Test User",
    roles: role ? [role] : [],
  };
}

function ok(message: string, data: unknown = null, meta?: unknown) {
  return { success: true as const, message, data, ...(meta !== undefined ? { meta } : {}) };
}

function fail(message: string, errors?: unknown) {
  return { success: false as const, message, data: null, ...(errors !== undefined ? { errors } : {}) };
}

function paginate<T>(items: T[], page: number, perPage: number) {
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const start = (page - 1) * perPage;
  return { items: items.slice(start, start + perPage), total, totalPages };
}

// ── Store + domain logic ───────────────────────────────────────────────────

export class NotificationStore {
  rows: NotificationRow[] = [];
  private seq = 1;

  reset(): void {
    this.rows = [];
    this.seq = 1;
  }

  create(input: { userId: number; type: string; title: string; body: string; data?: Record<string, unknown> | null }): NotificationRow {
    const row: NotificationRow = {
      id: this.seq++,
      userId: input.userId,
      type: input.type,
      title: input.title,
      body: input.body,
      data: input.data ?? null,
      readAt: null,
      createdAt: new Date().toISOString(),
    };
    this.rows.push(row);
    return row;
  }

  forUser(userId: number): NotificationRow[] {
    return this.rows.filter((r) => r.userId === userId).sort((a, b) => b.id - a.id);
  }

  unreadCount(userId: number): number {
    return this.rows.filter((r) => r.userId === userId && r.readAt === null).length;
  }

  /** Scoped lookup — someone else's notification reads as 404, not 403. */
  markRead(userId: number, id: number): NotificationRow | null {
    const row = this.rows.find((r) => r.id === id && r.userId === userId);
    if (!row) return null;
    if (row.readAt === null) row.readAt = new Date().toISOString();
    return row;
  }

  markAllRead(userId: number): number {
    const now = new Date().toISOString();
    let marked = 0;
    for (const r of this.rows) {
      if (r.userId === userId && r.readAt === null) {
        r.readAt = now;
        marked++;
      }
    }
    return marked;
  }
}

export const notificationStore = new NotificationStore();
export const pushTokenStore = new DeviceTokenStore();

/**
 * Single entry point for notifying a user: persist the in-app row, then
 * fan out to push best-effort. Never throws.
 */
export async function sendNotification(input: {
  userId: number;
  type: string;
  title: string;
  body: string;
  data?: Record<string, unknown> | null;
}) {
  const row = notificationStore.create(input);
  const tokens = pushTokenStore.forUser(input.userId);
  await sendPush({ id: row.id, type: row.type, title: row.title, body: row.body, data: row.data }, tokens, {
    store: pushTokenStore,
  });
  return row;
}

// ── HTTP ───────────────────────────────────────────────────────────────────

const pushTokenBody = t.Object({
  token: t.Optional(t.String()),
  device_token: t.Optional(t.String()),
  platform: t.String(),
  device_name: t.Optional(t.Union([t.String(), t.Null()])),
});

export const notificationsApp = new Elysia({ prefix: "/notifications" })
  .derive(({ headers }) => ({ user: resolveUser(headers) }))

  .get(
    "/",
    ({ query, user }) => {
      const page = Math.max(Number(query.page ?? "1") || 1, 1);
      const perPage = Math.min(Math.max(Number(query.per_page ?? "20") || 20, 1), 100);
      let rows = notificationStore.forUser(user.id);
      if (query.unread === "true" || query.unread === "1") rows = rows.filter((r) => r.readAt === null);
      if (query.type) rows = rows.filter((r) => r.type === query.type);
      const { items, total, totalPages } = paginate(rows, page, perPage);
      return ok("Notifications retrieved.", items, {
        page,
        per_page: perPage,
        total,
        total_pages: totalPages,
        unread_count: notificationStore.unreadCount(user.id),
      });
    },
    {
      query: t.Object({
        page: t.Optional(t.String()),
        per_page: t.Optional(t.String()),
        unread: t.Optional(t.String()),
        type: t.Optional(t.String()),
      }),
    },
  )

  .post("/push-token", ({ body, user, set }) => {
    const token = body.token ?? body.device_token ?? "";
    const { row, errors } = pushTokenStore.register({
      userId: user.id,
      token,
      platform: body.platform,
      deviceName: body.device_name ?? null,
    });
    if (errors.length > 0) {
      set.status = 422;
      return fail("Invalid push token.", errors);
    }
    return ok("Push token registered.", row);
  }, { body: pushTokenBody })

  .delete(
    "/push-token",
    ({ body, query, user }) => {
      const token = body?.token ?? body?.device_token ?? query.token ?? query.device_token ?? "";
      const removed = pushTokenStore.remove(user.id, token);
      return ok(removed ? "Push token removed." : "No matching push token found.", { removed });
    },
    {
      body: t.Optional(
        t.Object({
          token: t.Optional(t.String()),
          device_token: t.Optional(t.String()),
        }),
      ),
      query: t.Object({
        token: t.Optional(t.String()),
        device_token: t.Optional(t.String()),
      }),
    },
  )

  // Registered BEFORE /:id/read or the wildcard swallows "read-all".
  .post("/read-all", ({ user }) => {
    const marked = notificationStore.markAllRead(user.id);
    return ok(`${marked} notification(s) marked as read.`, { marked, unread_count: 0 });
  })

  .post("/:id/read", ({ params, user, set }) => {
    const id = Number(params.id);
    if (!Number.isInteger(id)) {
      set.status = 404;
      return fail("Notification not found.");
    }
    const row = notificationStore.markRead(user.id, id);
    if (!row) {
      set.status = 404;
      return fail("Notification not found.");
    }
    return ok("Notification marked as read.", row, { unread_count: notificationStore.unreadCount(user.id) });
  }, { params: t.Object({ id: t.String() }) });

export default notificationsApp;
