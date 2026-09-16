// src/modules/chat/index.ts
//
// Chat archive, history and presence.
//
// Firebase RTDB stays the realtime delivery layer — these endpoints are the
// durable half of a double-write: the client posts to RTDB, then mirrors
// the message here. `conversation_id` is the client's own Firebase key
// (a string, NOT a UUID) and is never the access check — authorization is
// row-level participation (sender/receiver match), widened for staff.
//
// Endpoints (mounted under /chat):
//   POST /chat/sync                  bulk upsert archive { messages[] }
//   POST /chat/presence              heartbeat { is_online, last_seen }
//   GET  /chat/conversations         inbox grouped by conversation_id
//   GET  /chat/:conversationId       thread history ?limit&before
//   POST /chat/:conversationId/read  mark thread read
//
// Auth: real JWT guard (applyAuthGuard) resolving the shared UserStore.
// User ids are STRINGS everywhere (the identity layer maps Postgres bigint
// `users.id` to String at the seam — see src/db/stores.ts). The wire protocol
// accepts numeric receiver ids from legacy clients and normalizes them.

import { Elysia, t, type AnyElysia } from "elysia";
import { applyAuthGuard, type UserStore } from "../auth/index";
import { getDbStores } from "../../db/stores";

// ── Types ──────────────────────────────────────────────────────────────────

export const MESSAGE_TYPES = ["text", "image", "file"] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

export interface ChatMessageRow {
  id: number;
  conversationId: string;
  participantKey: string;
  clientMessageId: string;
  senderId: string;
  receiverId: string;
  message: string | null;
  messageType: MessageType;
  attachmentUrl: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface SyncMessageInput {
  conversation_id: string;
  client_message_id: string;
  receiver_id: string;
  message?: string | null;
  message_type?: string;
  attachment_url?: string | null;
}

export interface ConversationSummary {
  conversation_id: string;
  participant: { id: string; is_online: boolean; last_seen: string | null } | null;
  last_message: ChatMessageRow;
  unread_count: number;
  updated_at: string;
}

export interface PresenceRow {
  userId: string;
  isOnline: boolean;
  lastSeen: string;
}

// ── Shared envelope ─────────────────────────────────────────────────────────

function ok(message: string, data: unknown = null, meta?: unknown) {
  return { success: true as const, message, data, ...(meta !== undefined ? { meta } : {}) };
}

function fail(message: string, errors?: unknown) {
  return { success: false as const, message, data: null, ...(errors !== undefined ? { errors } : {}) };
}

function isStaff(user: { roles: string[] }): boolean {
  return user.roles.includes("admin") || user.roles.includes("verifier");
}

// ── Pure domain logic (unit-tested) ────────────────────────────────────────

/** Canonical pair key: "{lowerId}-{higherId}", derived server-side. */
export function participantKeyFor(a: string, b: string): string {
  const sorted = [a, b].sort((x, y) => {
    const xn = Number(x);
    const yn = Number(y);
    const bothNumeric = Number.isFinite(xn) && Number.isFinite(yn) && String(xn) === x && String(yn) === y;
    return bothNumeric ? xn - yn : x.localeCompare(y);
  });
  return `${sorted[0]}-${sorted[1]}`;
}

function validateSyncItem(item: SyncMessageInput, senderId: string): string | null {
  if (!item.conversation_id || item.conversation_id.length > 191) return "conversation_id is required (max 191 chars).";
  if (!item.client_message_id || item.client_message_id.length > 128) return "client_message_id is required (max 128 chars).";
  if (!item.receiver_id || item.receiver_id.length > 64) return "receiver_id is required.";
  if (item.receiver_id === senderId) return "You cannot send a message to yourself.";
  if (item.message_type !== undefined && !(MESSAGE_TYPES as readonly string[]).includes(item.message_type)) {
    return `message_type must be one of: ${MESSAGE_TYPES.join(", ")}.`;
  }
  if ((item.message === undefined || item.message === null || item.message === "") && !item.attachment_url) {
    return "message is required unless attachment_url is present.";
  }
  if (item.message !== undefined && item.message !== null && item.message.length > 5000) {
    return "message must not exceed 5000 characters.";
  }
  return null;
}

export class ChatStore {
  messages: ChatMessageRow[] = [];
  presence = new Map<string, PresenceRow>();
  private seq = 1;

  reset(): void {
    this.messages = [];
    this.presence.clear();
    this.seq = 1;
  }

  /**
   * Bulk upsert archive. Idempotent per (conversation_id, sender_id,
   * client_message_id): replays return the stored row instead of a
   * duplicate. All-or-nothing on validation — returns errors, inserts nothing.
   */
  syncBatch(
    senderId: string,
    items: SyncMessageInput[],
  ): { created: ChatMessageRow[]; duplicates: ChatMessageRow[]; errors: Array<{ index: number; error: string }> } {
    const errors: Array<{ index: number; error: string }> = [];
    items.forEach((item, index) => {
      const err = validateSyncItem(item, senderId);
      if (err) {
        errors.push({ index, error: err });
        return;
      }
      const key = participantKeyFor(senderId, item.receiver_id);
      const clash = this.messages.find(
        (m) => m.conversationId === item.conversation_id && m.participantKey !== key,
      );
      if (clash) errors.push({ index, error: "This conversation_id is already in use by another conversation." });
    });
    if (errors.length > 0) return { created: [], duplicates: [], errors };

    const created: ChatMessageRow[] = [];
    const duplicates: ChatMessageRow[] = [];
    for (const item of items) {
      const existing = this.messages.find(
        (m) =>
          m.conversationId === item.conversation_id &&
          m.senderId === senderId &&
          m.clientMessageId === item.client_message_id,
      );
      if (existing) {
        duplicates.push(existing);
        continue;
      }
      const now = new Date().toISOString();
      const row: ChatMessageRow = {
        id: this.seq++,
        conversationId: item.conversation_id,
        participantKey: participantKeyFor(senderId, item.receiver_id),
        clientMessageId: item.client_message_id,
        senderId,
        receiverId: item.receiver_id,
        message: item.message ?? null,
        messageType: ((item.message_type as MessageType) ?? "text"),
        attachmentUrl: item.attachment_url ?? null,
        readAt: null,
        createdAt: now,
      };
      this.messages.push(row);
      created.push(row);
    }
    return { created, duplicates, errors: [] };
  }

  visibleTo(userId: string, staff: boolean): ChatMessageRow[] {
    if (staff) return this.messages;
    return this.messages.filter((m) => m.senderId === userId || m.receiverId === userId);
  }
}

export function countUnread(messages: ChatMessageRow[], userId: string, conversationId?: string): number {
  return messages.filter(
    (m) =>
      m.receiverId === userId &&
      m.readAt === null &&
      (conversationId === undefined || m.conversationId === conversationId),
  ).length;
}

/**
 * The inbox: every conversation the user participates in, newest first,
 * each with its latest message, unread count and counterpart presence.
 */
export function groupConversations(
  store: ChatStore,
  userId: string,
  staff = false,
): ConversationSummary[] {
  const visible = store.visibleTo(userId, staff);
  const ids = [...new Set(visible.map((m) => m.conversationId))];
  return ids
    .map((conversationId): ConversationSummary | null => {
      const thread = visible.filter((m) => m.conversationId === conversationId);
      if (thread.length === 0) return null;
      const last = thread.reduce((a, b) => (b.id > a.id ? b : a));
      const otherId = last.senderId === userId ? last.receiverId : last.senderId;
      const presence = store.presence.get(otherId);
      return {
        conversation_id: conversationId,
        participant: {
          id: otherId,
          is_online: presence?.isOnline ?? false,
          last_seen: presence?.lastSeen ?? null,
        },
        last_message: last,
        unread_count: countUnread(thread, userId),
        updated_at: last.createdAt,
      };
    })
    .filter((c): c is ConversationSummary => c !== null)
    .sort((a, b) =>
      a.updated_at !== b.updated_at
        ? (a.updated_at < b.updated_at ? 1 : -1)
        : b.last_message.id - a.last_message.id,
    );
}

export function getHistory(
  store: ChatStore,
  userId: string,
  conversationId: string,
  staff: boolean,
  opts?: { limit?: number; before?: number },
): { messages: ChatMessageRow[]; unreadCount: number; hasMore: boolean } {
  const limit = Math.min(Math.max(opts?.limit ?? 30, 1), 100);
  const thread = store
    .visibleTo(userId, staff)
    .filter((m) => m.conversationId === conversationId)
    .sort((a, b) => b.id - a.id);
  const windowed = opts?.before !== undefined ? thread.filter((m) => m.id < opts.before!) : thread;
  return {
    messages: windowed.slice(0, limit),
    unreadCount: countUnread(thread, userId),
    hasMore: windowed.length > limit,
  };
}

export function markConversationRead(store: ChatStore, userId: string, conversationId: string): number {
  const now = new Date().toISOString();
  let marked = 0;
  for (const m of store.messages) {
    if (m.conversationId === conversationId && m.receiverId === userId && m.readAt === null) {
      m.readAt = now;
      marked++;
    }
  }
  return marked;
}

export const chatStore = new ChatStore();

// ── HTTP ───────────────────────────────────────────────────────────────────

const syncItemSchema = t.Object({
  conversation_id: t.String({ maxLength: 191 }),
  client_message_id: t.String({ maxLength: 128 }),
  receiver_id: t.Union([t.Number(), t.String({ maxLength: 64 })]),
  message: t.Optional(t.Union([t.String({ maxLength: 5000 }), t.Null()])),
  message_type: t.Optional(t.String()),
  attachment_url: t.Optional(t.Union([t.String(), t.Null()])),
});

export interface ChatPluginOptions {
  users?: UserStore;
  secret?: string;
}

export function createChatPlugin<const T extends AnyElysia = AnyElysia>(options: ChatPluginOptions = {}) {
  return applyAuthGuard(new Elysia({ prefix: "/chat" }), {
    secret: options.secret,
    users: options.users ?? getDbStores()?.users,
  })

    .post(
      "/sync",
      ({ body, currentUser, set }) => {
        const messages = (body.messages as Array<Record<string, unknown>>).map((m) => ({
          ...m,
          receiver_id: String(m.receiver_id as number | string),
        }));
        const result = chatStore.syncBatch(currentUser.id, messages as SyncMessageInput[]);
        if (result.errors.length > 0) {
          set.status = 422;
          return fail("Some messages failed validation.", result.errors);
        }
        const all = [...result.created, ...result.duplicates];
        set.status = result.created.length > 0 ? 201 : 200;
        return ok(
          result.created.length > 0 ? "Messages archived." : "Messages already archived.",
          all,
          { created: result.created.length, duplicates: result.duplicates.length },
        );
      },
      { body: t.Object({ messages: t.Array(syncItemSchema, { minItems: 1, maxItems: 100 }) }) },
    )

    .post(
      "/presence",
      ({ body, currentUser }) => {
        const lastSeen = body.last_seen ?? new Date().toISOString();
        chatStore.presence.set(currentUser.id, { userId: currentUser.id, isOnline: body.is_online, lastSeen });
        return ok("Presence updated.", { id: currentUser.id, is_online: body.is_online, last_seen: lastSeen });
      },
      {
        body: t.Object({
          is_online: t.Boolean(),
          last_seen: t.Optional(t.String()),
        }),
      },
    )

    // Static segment registered BEFORE /:conversationId or the wildcard swallows it.
    .get("/conversations", ({ currentUser }) => {
      const conversations = groupConversations(chatStore, currentUser.id, isStaff(currentUser));
      return ok("Conversations retrieved.", conversations);
    })

    .get(
      "/:conversationId",
      ({ params, query, currentUser }) => {
        const limit = query.limit !== undefined ? Number(query.limit) : 30;
        const before = query.before !== undefined ? Number(query.before) : undefined;
        const { messages, unreadCount, hasMore } = getHistory(chatStore, currentUser.id, params.conversationId, isStaff(currentUser), {
          limit: Number.isFinite(limit) ? limit : 30,
          before: before !== undefined && Number.isFinite(before) ? before : undefined,
        });
        return ok("Conversation history retrieved.", messages, {
          conversation_id: params.conversationId,
          unread_count: unreadCount,
          has_more: hasMore,
        });
      },
      {
        params: t.Object({ conversationId: t.String() }),
        query: t.Object({ limit: t.Optional(t.String()), before: t.Optional(t.String()) }),
      },
    )

    .post(
      "/:conversationId/read",
      ({ params, currentUser }) => {
        const marked = markConversationRead(chatStore, currentUser.id, params.conversationId);
        return ok("Conversation marked as read.", { marked, unread_count: 0 });
      },
      { params: t.Object({ conversationId: t.String() }) },
    );
}

/** Default singleton plugin (real JWT guard; shared UserStore). */
export const chatApp = createChatPlugin();

export default chatApp;