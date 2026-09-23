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
//
// Auth: real JWT guard (applyAuthGuard) resolving the shared UserStore.
// User ids are strings (see src/db/stores.ts).

import { Elysia, t } from "elysia";
import { applyAuthGuard, userStore, type UserStore } from "../auth/index";
import { getDbStores } from "../../db/stores";
import { DeviceTokenStore, sendPush, type DeviceTokenRegistry } from "../../services/push";

// ── Notification Settings ──────────────────────────────────────────────────

export const DEFAULT_NOTIFICATION_SETTINGS: Record<string, boolean> = {
  push_enabled: true,
  email_enabled: true,
  sms_enabled: true,
  email_hot_deals: true,
  email_info_about_ads: true,
  email_premium_packages: true,
  email_subscriptions: true,
  email_messages: true,
  email_feedback: true,
  push_new_messages: true,
  push_new_orders: true,
  push_price_drops: true,
  push_new_listings: true,
  push_promotions: true,
  sms_order_updates: true,
  sms_security_alerts: true,
  view_notifications_push: true,
  view_notifications_daily_email: true,
};

export function toSnakeCase(str: string): string {
  return str.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

export function toCamelCase(str: string): string {
  return str.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

export function resolveNotificationSettings(
  saved?: Record<string, unknown> | null,
): Record<string, boolean> {
  const normalized: Record<string, boolean> = {};
  if (saved && typeof saved === "object") {
    for (const [key, val] of Object.entries(saved)) {
      normalized[toSnakeCase(key)] = Boolean(val);
    }
  }
  const merged: Record<string, boolean> = {
    ...DEFAULT_NOTIFICATION_SETTINGS,
    ...normalized,
  };
  for (const key of Object.keys(DEFAULT_NOTIFICATION_SETTINGS)) {
    const camel = toCamelCase(key);
    merged[camel] = merged[key] ?? true;
  }
  return merged;
}

// ── Types ──────────────────────────────────────────────────────────────────

export interface NotificationRow {
  id: number;
  userId: string;
  type: string;
  title: string;
  body: string;
  data: Record<string, unknown> | null;
  readAt: string | null;
  createdAt: string;
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

  create(input: { userId: string; type: string; title: string; body: string; data?: Record<string, unknown> | null }): NotificationRow {
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

  forUser(userId: string): NotificationRow[] {
    return this.rows.filter((r) => r.userId === userId).sort((a, b) => b.id - a.id);
  }

  unreadCount(userId: string): number {
    return this.rows.filter((r) => r.userId === userId && r.readAt === null).length;
  }

  /** Scoped lookup — someone else's notification reads as 404, not 403. */
  markRead(userId: string, id: number): NotificationRow | null {
    const row = this.rows.find((r) => r.id === id && r.userId === userId);
    if (!row) return null;
    if (row.readAt === null) row.readAt = new Date().toISOString();
    return row;
  }

  markAllRead(userId: string): number {
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

/**
 * Store surface consumed by the route handlers. Returns are widened to
 * `T | Promise<T>` so the DB-backed overlay (createDbNotificationStore) can
 * implement the same shape as the in-memory NotificationStore — handlers
 * uniformly `await`, which is a no-op for the synchronous memory store.
 */
export interface NotificationStoreLike {
  create(input: { userId: string; type: string; title: string; body: string; data?: Record<string, unknown> | null }):
    | NotificationRow
    | Promise<NotificationRow>;
  forUser(userId: string): NotificationRow[] | Promise<NotificationRow[]>;
  unreadCount(userId: string): number | Promise<number>;
  markRead(userId: string, id: number): NotificationRow | null | Promise<NotificationRow | null>;
  markAllRead(userId: string): number | Promise<number>;
  reset(): void | Promise<void>;
}

export const notificationStore = new NotificationStore();
export const pushTokenStore = new DeviceTokenStore();

/**
 * Single entry point for notifying a user: persist the in-app row, then
 * fan out to push best-effort. Never throws.
 *
 * Resolves the DB-backed stores when Postgres is reachable, falling back to
 * the module singletons (which is the memory path tests run on). Callers can
 * pin explicit stores via the second argument to stay on a specific store.
 */
export async function sendNotification(
  input: {
    userId: string;
    type: string;
    title: string;
    body: string;
    data?: Record<string, unknown> | null;
  },
  stores?: { store?: NotificationStoreLike; pushTokens?: DeviceTokenRegistry },
) {
  const store = stores?.store ?? getDbStores()?.notifications ?? notificationStore;
  const pushTokens = stores?.pushTokens ?? getDbStores()?.deviceTokens ?? pushTokenStore;
  const row = await store.create(input);
  const tokens = await pushTokens.forUser(input.userId);
  await sendPush({ id: row.id, type: row.type, title: row.title, body: row.body, data: row.data }, tokens, {
    store: pushTokens,
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

export interface NotificationsPluginOptions {
  users?: UserStore;
  secret?: string;
  /** In-app notification store (memory default; DB-backed in production). */
  store?: NotificationStoreLike;
  /** Push-token registry (memory default; DB-backed in production). */
  pushTokens?: DeviceTokenRegistry;
}

export function createNotificationsPlugin(options: NotificationsPluginOptions = {}) {
  const store = options.store ?? getDbStores()?.notifications ?? notificationStore;
  const pushTokens = options.pushTokens ?? getDbStores()?.deviceTokens ?? pushTokenStore;

  return applyAuthGuard(new Elysia({ prefix: "/notifications" }), {
    secret: options.secret,
    users: options.users ?? getDbStores()?.users,
  })

    .get(
      "/",
      async ({ query, currentUser }) => {
        const page = Math.max(Number(query.page ?? "1") || 1, 1);
        const perPage = Math.min(Math.max(Number(query.per_page ?? "20") || 20, 1), 100);
        let rows = await store.forUser(currentUser.id);
        if (query.unread === "true" || query.unread === "1") rows = rows.filter((r) => r.readAt === null);
        if (query.type) rows = rows.filter((r) => r.type === query.type);
        const { items, total, totalPages } = paginate(rows, page, perPage);
        return ok("Notifications retrieved.", items, {
          page,
          per_page: perPage,
          total,
          total_pages: totalPages,
          unread_count: await store.unreadCount(currentUser.id),
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

    .get("/settings", async ({ currentUser }) => {
      return ok("Notification preferences retrieved.", {
        settings: resolveNotificationSettings(currentUser.notification_settings),
      });
    })

    .put(
      "/settings",
      async ({ body, currentUser, set }) => {
        const rawPayload = (body as any)?.settings ?? body ?? {};
        if (
          typeof rawPayload !== "object" ||
          rawPayload === null ||
          Array.isArray(rawPayload)
        ) {
          set.status = 422;
          return fail("Invalid settings format");
        }
        const current: Record<string, boolean> = {
          ...(currentUser.notification_settings ?? {}),
        };
        for (const [k, v] of Object.entries(rawPayload)) {
          const snake = toSnakeCase(k);
          if (snake in DEFAULT_NOTIFICATION_SETTINGS) {
            current[snake] = Boolean(v);
          }
        }
        const usersStore = options.users ?? getDbStores()?.users ?? userStore;
        await usersStore.update(currentUser.id, {
          notification_settings: current,
        });
        return ok("Notification preferences updated.", {
          settings: resolveNotificationSettings(current),
        });
      },
      { body: t.Any() },
    )

    .patch(
      "/settings",
      async ({ body, currentUser, set }) => {
        const rawPayload = (body as any)?.settings ?? body ?? {};
        if (
          typeof rawPayload !== "object" ||
          rawPayload === null ||
          Array.isArray(rawPayload)
        ) {
          set.status = 422;
          return fail("Invalid settings format");
        }
        const current: Record<string, boolean> = {
          ...(currentUser.notification_settings ?? {}),
        };
        for (const [k, v] of Object.entries(rawPayload)) {
          const snake = toSnakeCase(k);
          if (snake in DEFAULT_NOTIFICATION_SETTINGS) {
            current[snake] = Boolean(v);
          }
        }
        const usersStore = options.users ?? getDbStores()?.users ?? userStore;
        await usersStore.update(currentUser.id, {
          notification_settings: current,
        });
        return ok("Notification preferences updated.", {
          settings: resolveNotificationSettings(current),
        });
      },
      { body: t.Any() },
    )

    .post("/push-token", async ({ body, currentUser, set }) => {
      const token = body.token ?? body.device_token ?? "";
      const { row, errors } = await pushTokens.register({
        userId: currentUser.id,
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
      async ({ body, query, currentUser }) => {
        const token = body?.token ?? body?.device_token ?? query.token ?? query.device_token ?? "";
        const removed = await pushTokens.remove(currentUser.id, token);
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
    .post("/read-all", async ({ currentUser }) => {
      const marked = await store.markAllRead(currentUser.id);
      return ok(`${marked} notification(s) marked as read.`, { marked, unread_count: 0 });
    })

    .post("/:id/read", async ({ params, currentUser, set }) => {
      const id = Number(params.id);
      if (!Number.isInteger(id)) {
        set.status = 404;
        return fail("Notification not found.");
      }
      const row = await store.markRead(currentUser.id, id);
      if (!row) {
        set.status = 404;
        return fail("Notification not found.");
      }
      return ok("Notification marked as read.", row, { unread_count: await store.unreadCount(currentUser.id) });
    }, { params: t.Object({ id: t.String() }) });
}

/** Default singleton plugin (real JWT guard; shared UserStore). */
export const notificationsApp = createNotificationsPlugin();

export default notificationsApp;