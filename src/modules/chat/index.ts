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

import { Elysia, t } from "elysia";
import { pgTable, serial, integer, varchar, text, timestamp } from "drizzle-orm/pg-core";

// ── Drizzle contract (Postgres wiring seam; runtime uses in-memory store) ──

export const chatMessages = pgTable("chat_messages", {
  id: serial("id").primaryKey(),
  conversationId: varchar("conversation_id", { length: 191 }).notNull(),
  participantKey: varchar("participant_key", { length: 64 }).notNull(),
  clientMessageId: varchar("client_message_id", { length: 128 }).notNull(),
  senderId: integer("sender_id").notNull(),
  receiverId: integer("receiver_id").notNull(),
  message: text("message"),
  messageType: varchar("message_type", { length: 10 }).notNull().default("text"),
  attachmentUrl: varchar("attachment_url", { length: 2048 }),
  readAt: timestamp("read_at"),
  createdAt: timestamp("created_at").defaultNow(),
});

// ── Types ──────────────────────────────────────────────────────────────────

export const MESSAGE_TYPES = ["text", "image", "file"] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

export interface ChatMessageRow {
  id: number;
  conversationId: string;
  participantKey: string;
  clientMessageId: string;
  senderId: number;
  receiverId: number;
  message: string | null;
  messageType: MessageType;
  attachmentUrl: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface SyncMessageInput {
  conversation_id: string;
  client_message_id: string;
  receiver_id: number;
  message?: string | null;
  message_type?: string;
  attachment_url?: string | null;
}

export interface ConversationSummary {
  conversation_id: string;
  participant: { id: number; is_online: boolean; last_seen: string | null } | null;
  last_message: ChatMessageRow;
  unread_count: number;
  updated_at: string;
}

export interface PresenceRow {
  userId: number;
  isOnline: boolean;
  lastSeen: string;
}

// ── Shared envelope + auth stub (local copies; do not cross-import) ────────

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

function isStaff(user: AuthUser): boolean {
  return user.roles.includes("admin") || user.roles.includes("verifier");
}

function ok(message: string, data: unknown = null, meta?: unknown) {
  return { success: true as const, message, data, ...(meta !== undefined ? { meta } : {}) };
}

function fail(message: string, errors?: unknown) {
  return { success: false as const, message, data: null, ...(errors !== undefined ? { errors } : {}) };
}

// ── Pure domain logic (unit-tested) ────────────────────────────────────────

/** Canonical pair key: "{lowerId}-{higherId}", derived server-side. */
export function participantKeyFor(a: number, b: number): string {
  return `${Math.min(a, b)}-${Math.max(a, b)}`;
}

function validateSyncItem(item: SyncMessageInput, senderId: number): string | null {
  if (!item.conversation_id || item.conversation_id.length > 191) return "conversation_id is required (max 191 chars).";
  if (!item.client_message_id || item.client_message_id.length > 128) return "client_message_id is required (max 128 chars).";
  if (!Number.isInteger(item.receiver_id) || item.receiver_id <= 0) return "receiver_id must be a positive integer.";
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
  presence = new Map<number, PresenceRow>();
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
    senderId: number,
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

  visibleTo(userId: number, staff: boolean): ChatMessageRow[] {
    if (staff) return this.messages;
    return this.messages.filter((m) => m.senderId === userId || m.receiverId === userId);
  }
}

export function countUnread(messages: ChatMessageRow[], userId: number, conversationId?: string): number {
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
  userId: number,
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
  userId: number,
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

export function markConversationRead(store: ChatStore, userId: number, conversationId: string): number {
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
  receiver_id: t.Number(),
  message: t.Optional(t.Union([t.String({ maxLength: 5000 }), t.Null()])),
  message_type: t.Optional(t.String()),
  attachment_url: t.Optional(t.Union([t.String(), t.Null()])),
});

export const chatApp = new Elysia({ prefix: "/chat" })
  .derive(({ headers }) => ({ user: resolveUser(headers) }))

  .post(
    "/sync",
    ({ body, user, set }) => {
      const result = chatStore.syncBatch(user.id, body.messages);
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
    ({ body, user }) => {
      const lastSeen = body.last_seen ?? new Date().toISOString();
      chatStore.presence.set(user.id, { userId: user.id, isOnline: body.is_online, lastSeen });
      return ok("Presence updated.", { id: user.id, is_online: body.is_online, last_seen: lastSeen });
    },
    {
      body: t.Object({
        is_online: t.Boolean(),
        last_seen: t.Optional(t.String()),
      }),
    },
  )

  // Static segment registered BEFORE /:conversationId or the wildcard swallows it.
  .get("/conversations", ({ user }) => {
    const conversations = groupConversations(chatStore, user.id, isStaff(user));
    return ok("Conversations retrieved.", conversations);
  })

  .get(
    "/:conversationId",
    ({ params, query, user }) => {
      const limit = query.limit !== undefined ? Number(query.limit) : 30;
      const before = query.before !== undefined ? Number(query.before) : undefined;
      const { messages, unreadCount, hasMore } = getHistory(chatStore, user.id, params.conversationId, isStaff(user), {
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
    ({ params, user }) => {
      const marked = markConversationRead(chatStore, user.id, params.conversationId);
      return ok("Conversation marked as read.", { marked, unread_count: 0 });
    },
    { params: t.Object({ conversationId: t.String() }) },
  );

export default chatApp;
