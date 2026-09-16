// src/services/push.ts
//
// Expo push delivery + device-token registry.
//
// Mirrors DistressNowApi's App\Services\ExpoPushService (+ the token
// registry half of NotificationController). Sends via fetch to
// https://exp.host/--/api/v2/push/send in chunks of 100, prunes
// DeviceNotRegistered tokens, and never throws — delivery runs
// best-effort so a dead Expo endpoint can't cascade into failed jobs.
//
// Mock mode: when EXPO_PUSH_ENABLED=false the send is logged and skipped
// so local dev and CI never reach the network.
//
// User ids are strings (see src/db/stores.ts). The DB table contract for
// device_tokens lives in src/db/schema.ts.

export const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

/** Expo issues both spellings depending on SDK version; accept either. */
export const EXPO_TOKEN_PATTERN = /^(ExponentPushToken|ExpoPushToken)\[[^\[\]]+\]$/;

export const PUSH_PLATFORMS = ["ios", "android", "web"] as const;
export type PushPlatform = (typeof PUSH_PLATFORMS)[number];

/** Expo rejects requests carrying more than 100 messages. */
export const EXPO_CHUNK_SIZE = 100;

// ── Types ──────────────────────────────────────────────────────────────────

export interface PushNotification {
  id: number | string;
  type: string;
  title: string;
  body: string;
  data?: Record<string, unknown> | null;
}

export interface DeviceTokenRow {
  id: number;
  userId: string;
  token: string;
  platform: PushPlatform;
  deviceName: string | null;
  lastUsedAt: string | null;
}

export interface ExpoPushMessage {
  to: string;
  title: string;
  body: string;
  sound: "default";
  data: Record<string, unknown>;
}

export interface ExpoReceipt {
  status: "ok" | "error";
  details?: { error?: string };
}

export interface SendPushResult {
  mocked: boolean;
  attempted: number;
  sent: number;
  pruned: string[];
}

export interface BroadcastPayload {
  type: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  channels: string[];
}

// ── Config ─────────────────────────────────────────────────────────────────

export function isPushEnabled(): boolean {
  const raw = (process.env.EXPO_PUSH_ENABLED ?? "true").toLowerCase();
  return raw !== "false" && raw !== "0" && raw !== "no" && raw !== "off";
}

function expoAccessToken(): string | null {
  return process.env.EXPO_ACCESS_TOKEN ?? null;
}

// ── Pure builders (unit-tested, no I/O) ────────────────────────────────────

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function buildExpoMessages(
  notification: PushNotification,
  tokens: Array<DeviceTokenRow | string>,
): ExpoPushMessage[] {
  return tokens.map((t) => ({
    to: typeof t === "string" ? t : t.token,
    title: notification.title,
    body: notification.body,
    sound: "default" as const,
    data: {
      notification_id: notification.id,
      type: notification.type,
      ...(notification.data ?? {}),
    },
  }));
}

/**
 * Expo returns one receipt per message in request order. A
 * DeviceNotRegistered / InvalidCredentials error means the app was
 * uninstalled or the token rotated — those tokens must be dropped so the
 * table doesn't fill with corpses.
 */
export function extractDeadTokens(receipts: ExpoReceipt[], tokens: string[]): string[] {
  const dead: string[] = [];
  receipts.forEach((receipt, index) => {
    if (receipt.status !== "error") return;
    const code = receipt.details?.error;
    const token = tokens[index];
    if ((code === "DeviceNotRegistered" || code === "InvalidCredentials") && token !== undefined) {
      dead.push(token);
    }
  });
  return dead;
}

/**
 * Announcement broadcast payload. Push-only by default — an announcement
 * fans out to the whole user base, so email/SMS here would be a billing
 * mistake (mirrors NotificationService::channelsFor fallback).
 */
export function buildBroadcastPayload(input: {
  title: string;
  body: string;
  type?: string;
  data?: Record<string, unknown>;
  channels?: string[];
}): BroadcastPayload {
  return {
    type: input.type ?? "announcement",
    title: input.title,
    body: input.body,
    data: input.data ?? {},
    channels: input.channels ?? ["push"],
  };
}

// ── Token registry ─────────────────────────────────────────────────────────

export interface RegisterTokenInput {
  userId: string;
  token: string;
  platform: string;
  deviceName?: string | null;
}

/**
 * Token-registry surface shared by the notifications module and sendPush.
 *
 * Returns are widened to `T | Promise<T>` so the DB-backed overlay
 * (createDbDeviceTokenStore) can implement the same shape as the in-memory
 * DeviceTokenStore — route handlers uniformly `await`, which is a no-op for
 * the synchronous memory store.
 */
export interface DeviceTokenRegistry {
  register(input: RegisterTokenInput):
    | { row: DeviceTokenRow | null; errors: string[] }
    | Promise<{ row: DeviceTokenRow | null; errors: string[] }>;
  remove(userId: string, token: string): boolean | Promise<boolean>;
  prune(tokens: string[]): number | Promise<number>;
  forUser(userId: string): DeviceTokenRow[] | Promise<DeviceTokenRow[]>;
  reset(): void | Promise<void>;
}

export class DeviceTokenStore {
  private rows = new Map<string, DeviceTokenRow>();
  private seq = 1;

  /**
   * Register (or re-register) an Expo push token.
   *
   * Keyed on the token, not on user+token: a handset handed to another
   * account must be reassigned, otherwise the previous owner keeps
   * receiving its pushes.
   */
  register(input: RegisterTokenInput): { row: DeviceTokenRow | null; errors: string[] } {
    const errors: string[] = [];
    if (!input.token || !EXPO_TOKEN_PATTERN.test(input.token)) {
      errors.push("The token must be a valid Expo push token, e.g. ExponentPushToken[xxxx].");
    }
    if (!(PUSH_PLATFORMS as readonly string[]).includes(input.platform)) {
      errors.push(`Platform must be one of: ${PUSH_PLATFORMS.join(", ")}.`);
    }
    if (errors.length > 0) return { row: null, errors };

    const now = new Date().toISOString();
    const existing = this.rows.get(input.token);
    if (existing) {
      existing.userId = input.userId;
      existing.platform = input.platform as PushPlatform;
      existing.deviceName = input.deviceName ?? existing.deviceName;
      existing.lastUsedAt = now;
      return { row: existing, errors: [] };
    }
    const row: DeviceTokenRow = {
      id: this.seq++,
      userId: input.userId,
      token: input.token,
      platform: input.platform as PushPlatform,
      deviceName: input.deviceName ?? null,
      lastUsedAt: now,
    };
    this.rows.set(input.token, row);
    return { row, errors: [] };
  }

  /** Scoped delete — a user can only remove their own token. */
  remove(userId: string, token: string): boolean {
    const existing = this.rows.get(token);
    if (!existing || existing.userId !== userId) return false;
    this.rows.delete(token);
    return true;
  }

  prune(tokens: string[]): number {
    let n = 0;
    for (const t of tokens) {
      if (this.rows.delete(t)) n++;
    }
    return n;
  }

  forUser(userId: string): DeviceTokenRow[] {
    return [...this.rows.values()].filter((r) => r.userId === userId);
  }

  count(): number {
    return this.rows.size;
  }

  reset(): void {
    this.rows.clear();
    this.seq = 1;
  }
}

// ── Delivery ───────────────────────────────────────────────────────────────

/**
 * Push one notification to the given device tokens. Never throws:
 * failures are swallowed after a console log so callers stay simple.
 */
export async function sendPush(
  notification: PushNotification,
  tokens: Array<DeviceTokenRow | string>,
  opts?: { fetchImpl?: typeof fetch; store?: DeviceTokenRegistry },
): Promise<SendPushResult> {
  const messages = buildExpoMessages(notification, tokens);
  if (messages.length === 0) return { mocked: false, attempted: 0, sent: 0, pruned: [] };

  if (!isPushEnabled()) {
    console.info("[Expo DEV] Push suppressed (EXPO_PUSH_ENABLED=false)", {
      notification_id: notification.id,
      type: notification.type,
      recipients: messages.map((m) => m.to),
      title: notification.title,
    });
    return { mocked: true, attempted: messages.length, sent: 0, pruned: [] };
  }

  const fetchImpl = opts?.fetchImpl ?? fetch;
  const token = expoAccessToken();
  let sent = 0;
  const pruned: string[] = [];

  for (const batch of chunk(messages, EXPO_CHUNK_SIZE)) {
    const batchTokens = batch.map((m) => m.to);
    try {
      const res = await fetchImpl(EXPO_PUSH_URL, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(batch),
      });
      if (!res.ok) {
        console.error("[Expo] Push rejected", { notification_id: notification.id, status: res.status });
        continue;
      }
      const json = (await res.json()) as { data?: ExpoReceipt[] };
      const dead = extractDeadTokens(json.data ?? [], batchTokens);
      if (dead.length > 0) {
        await opts?.store?.prune(dead);
        pruned.push(...dead);
        console.info("[Expo] Pruned unreachable device tokens", { count: dead.length });
      }
      sent += batch.length;
    } catch (err) {
      console.error("[Expo] Push request failed", {
        notification_id: notification.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { mocked: false, attempted: messages.length, sent, pruned };
}
