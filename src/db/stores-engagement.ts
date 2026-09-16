/**
 * Postgres-backed persistence overlays for the engagement / payments stores.
 *
 * The single source of truth for behaviour is the in-memory implementations:
 *  - TransactionStore       -> src/modules/payments/index.ts
 *  - NotificationStore      -> src/modules/notifications/index.ts
 *  - DeviceTokenRegistry    -> src/services/push.ts
 *  - SupportStore           -> src/modules/support/index.ts
 *  - AdvertStore            -> src/modules/adverts/index.ts
 *  - ReferralStore          -> src/modules/referrals/index.ts
 *  - SafetyStore            -> src/modules/safety/index.ts
 *  - ChatStore              -> src/modules/chat/index.ts
 *
 * These factories implement the SAME public interfaces so the modules can
 * swap the default stores at plugin construction time without touching any
 * route code. Tests keep passing explicit in-memory stores, so they stay on
 * the memory path regardless of DATABASE_URL.
 *
 * Id mapping: `users.id` is a bigint; the public user id is a string
 * (String(users.id)). All DB FK columns use bigint; these stores convert
 * at the seam via numericUserId().
 */

import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  or,
  sql,
} from "drizzle-orm";
import { db } from "./client";
import {
  adverts as advertsTable,
  chatMessages,
  deviceTokens as deviceTokensTable,
  notifications as notificationsTable,
  referralAttributions,
  safetyReports,
  supportMessages,
  supportTickets,
  transactions,
} from "./schema";
import { nowIso } from "../utils/phone";

// ── Type-only imports (no runtime cycle with modules) ──────────────────────

import type { TransactionStore, CreateTransactionInput, TransactionRecord } from "../modules/payments/index";
import type { NotificationRow } from "../modules/notifications/index";
import type { NotificationStoreLike } from "../modules/notifications/index";
import type { DeviceTokenRegistry, RegisterTokenInput, DeviceTokenRow } from "../services/push";
import type { SupportStoreLike, TicketRow, TicketMessageRow } from "../modules/support/index";
import type { AdvertStoreLike, AdvertRow } from "../modules/adverts/index";
import type { ReferralStoreLike, AttributionRow } from "../modules/referrals/index";
import type { SafetyStoreLike, SafetyReportRow } from "../modules/safety/index";
import type { ChatStoreLike, ChatMessageRow, SyncMessageInput, PresenceRow } from "../modules/chat/index";

// ── Shared helpers ────────────────────────────────────────────────────────

/** ISO string for a Date/timestamp value (null passthrough). */
export function toIso(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function toDate(value: string | number | Date | null | undefined): Date | null {
  if (value == null) return null;
  return value instanceof Date ? value : new Date(value);
}

/**
 * Public (string) user id → bigint `users.id`. Returns null when the id is
 * not numeric (test ids like "u1" never reach the DB seam).
 */
export function numericUserId(id: string | number | null | undefined): number | null {
  if (id == null) return null;
  const n = Number(id);
  return Number.isSafeInteger(n) ? n : null;
}

// ── Transactions (transactions) ───────────────────────────────────────────

/**
 * TransactionStore backed by the `transactions` table. Public user ids
 * (string) map to bigint `users.id` via numericUserId().
 */
export function createDbTransactionStore(): TransactionStore {
  type TxnRow = typeof transactions.$inferSelect;

  function rowToRecord(row: TxnRow): TransactionRecord {
    return {
      id: String(row.id),
      uuid: row.uuid,
      userId: String(row.userId),
      bookingId: row.bookingId != null ? String(row.bookingId) : null,
      reference: row.reference,
      amount: Number(row.amount),
      amountKobo: row.amountKobo,
      status: (row.status ?? "pending") as TransactionRecord["status"],
      channel: row.channel,
      gatewayResponse: row.gatewayResponse,
      authorization: (row.authorization as Record<string, unknown>) ?? null,
      metadata: (row.metadata as Record<string, unknown>) ?? null,
      paidAt: toIso(row.paidAt),
      createdAt: toIso(row.createdAt) ?? nowIso(),
      updatedAt: toIso(row.updatedAt) ?? nowIso(),
    };
  }

  return {
    async findByReference(reference: string): Promise<TransactionRecord | null> {
      const [row] = await db
        .select()
        .from(transactions)
        .where(eq(transactions.reference, reference))
        .limit(1);
      return row ? rowToRecord(row) : null;
    },

    async create(input: CreateTransactionInput): Promise<TransactionRecord> {
      const userId = numericUserId(input.userId);
      if (userId == null) throw new Error(`Cannot persist transaction: userId "${input.userId}" is not numeric.`);
      const [row] = await db
        .insert(transactions)
        .values({
          userId,
          bookingId: input.bookingId != null ? Number(input.bookingId) : null,
          reference: input.reference,
          amount: String(input.amount),
          amountKobo: input.amountKobo,
          status: "pending",
          metadata: (input.metadata as never) ?? null,
        })
        .returning();
      if (!row) throw new Error("transaction insert returned no row");
      return rowToRecord(row);
    },

    async update(
      reference: string,
      patch: Partial<TransactionRecord>,
    ): Promise<TransactionRecord | null> {
      const set: Partial<typeof transactions.$inferInsert> = {};
      if (patch.status !== undefined) set.status = patch.status;
      if (patch.channel !== undefined) set.channel = patch.channel;
      if (patch.gatewayResponse !== undefined) set.gatewayResponse = patch.gatewayResponse;
      if (patch.authorization !== undefined) set.authorization = (patch.authorization as never) ?? null;
      if (patch.metadata !== undefined) set.metadata = (patch.metadata as never) ?? null;
      if (patch.paidAt !== undefined) set.paidAt = toDate(patch.paidAt);
      if (patch.amount !== undefined) set.amount = String(patch.amount);
      if (patch.amountKobo !== undefined) set.amountKobo = patch.amountKobo;
      if ("bookingId" in patch) set.bookingId = patch.bookingId != null ? Number(patch.bookingId) : null;

      if (Object.keys(set).length === 0) {
        const [row] = await db.select().from(transactions).where(eq(transactions.reference, reference)).limit(1);
        return row ? rowToRecord(row) : null;
      }

      const [row] = await db
        .update(transactions)
        .set(set)
        .where(eq(transactions.reference, reference))
        .returning();
      return row ? rowToRecord(row) : null;
    },

    /** No-op for parity: DB rows persist across requests (tests use memory). */
    reset(): void {},
  };
}

// ── Notifications (notifications) ─────────────────────────────────────────

/**
 * NotificationStore backed by the `notifications` table.
 */
export function createDbNotificationStore(): NotificationStoreLike {
  type NotifRow = typeof notificationsTable.$inferSelect;

  function rowToRow(row: NotifRow): NotificationRow {
    return {
      id: row.id,
      userId: String(row.userId),
      type: row.type,
      title: row.title,
      body: row.body,
      data: (row.data as Record<string, unknown>) ?? null,
      readAt: toIso(row.readAt),
      createdAt: toIso(row.createdAt) ?? nowIso(),
    };
  }

  return {
    async create(input: {
      userId: string;
      type: string;
      title: string;
      body: string;
      data?: Record<string, unknown> | null;
    }): Promise<NotificationRow> {
      const userId = numericUserId(input.userId);
      if (userId == null) throw new Error(`Cannot persist notification: userId "${input.userId}" is not numeric.`);
      const [row] = await db
        .insert(notificationsTable)
        .values({
          userId,
          type: input.type,
          title: input.title,
          body: input.body,
          data: (input.data as never) ?? null,
          readAt: null,
        })
        .returning();
      if (!row) throw new Error("notification insert returned no row");
      return rowToRow(row);
    },

    async forUser(userId: string): Promise<NotificationRow[]> {
      const numeric = numericUserId(userId);
      if (numeric == null) return [];
      const rows = await db
        .select()
        .from(notificationsTable)
        .where(eq(notificationsTable.userId, numeric))
        .orderBy(desc(notificationsTable.id));
      return rows.map(rowToRow);
    },

    async unreadCount(userId: string): Promise<number> {
      const numeric = numericUserId(userId);
      if (numeric == null) return 0;
      const [row] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(notificationsTable)
        .where(
          and(eq(notificationsTable.userId, numeric), isNull(notificationsTable.readAt)),
        );
      return row?.count ?? 0;
    },

    async markRead(userId: string, id: number): Promise<NotificationRow | null> {
      const numeric = numericUserId(userId);
      if (numeric == null) return null;
      // Lookup first to match memory semantics (404 for missing/other-user).
      const [existing] = await db
        .select()
        .from(notificationsTable)
        .where(and(eq(notificationsTable.id, id), eq(notificationsTable.userId, numeric)))
        .limit(1);
      if (!existing) return null;
      // Idempotent: if already read, return as-is (no second update).
      if (existing.readAt === null) {
        await db
          .update(notificationsTable)
          .set({ readAt: new Date() })
          .where(eq(notificationsTable.id, id));
        existing.readAt = new Date();
      }
      return rowToRow(existing);
    },

    async markAllRead(userId: string): Promise<number> {
      const numeric = numericUserId(userId);
      if (numeric == null) return 0;
      const updated = await db
        .update(notificationsTable)
        .set({ readAt: new Date() })
        .where(
          and(eq(notificationsTable.userId, numeric), isNull(notificationsTable.readAt)),
        )
        .returning();
      return updated.length;
    },

    /** No-op for parity: DB rows persist across requests (tests use memory). */
    reset(): void {},
  };
}

// ── Device tokens (device_tokens) ─────────────────────────────────────────

/**
 * DeviceTokenRegistry backed by the `device_tokens` table. Token-keyed
 * reassignment matches the memory store semantics.
 */
export function createDbDeviceTokenStore(): DeviceTokenRegistry {
  type DtRow = typeof deviceTokensTable.$inferSelect;

  function rowToToken(row: DtRow): DeviceTokenRow {
    return {
      id: row.id,
      userId: String(row.userId),
      token: row.token,
      platform: row.platform as DeviceTokenRow["platform"],
      deviceName: row.deviceName,
      lastUsedAt: toIso(row.lastUsedAt),
    };
  }

  return {
    async register(input: RegisterTokenInput): Promise<{ row: DeviceTokenRow | null; errors: string[] }> {
      // Lazy-import to avoid circular deps at module evaluation.
      const { EXPO_TOKEN_PATTERN, PUSH_PLATFORMS } = await import("../services/push");
      const errors: string[] = [];
      if (!input.token || !EXPO_TOKEN_PATTERN.test(input.token)) {
        errors.push("The token must be a valid Expo push token, e.g. ExponentPushToken[xxxx].");
      }
      if (!(PUSH_PLATFORMS as readonly string[]).includes(input.platform)) {
        errors.push(`Platform must be one of: ${PUSH_PLATFORMS.join(", ")}.`);
      }
      const userId = numericUserId(input.userId);
      if (userId == null) {
        errors.push("User id is not numeric; cannot persist token.");
      }
      if (errors.length > 0) return { row: null, errors };

      const now = new Date();
      const [existing] = await db
        .select()
        .from(deviceTokensTable)
        .where(eq(deviceTokensTable.token, input.token))
        .limit(1);

      if (existing) {
        const [updated] = await db
          .update(deviceTokensTable)
          .set({
            userId: userId!,
            platform: input.platform as typeof deviceTokensTable.$inferInsert.platform,
            deviceName: input.deviceName ?? existing.deviceName,
            lastUsedAt: now,
          })
          .where(eq(deviceTokensTable.id, existing.id))
          .returning();
        return { row: rowToToken(updated!), errors: [] };
      }

      const [created] = await db
        .insert(deviceTokensTable)
        .values({
          userId: userId!,
          token: input.token,
          platform: input.platform as typeof deviceTokensTable.$inferInsert.platform,
          deviceName: input.deviceName ?? null,
          lastUsedAt: now,
        })
        .onConflictDoNothing()
        .returning();

      // Race: concurrent insert may have won — fetch existing.
      if (!created) {
        const [race] = await db
          .select()
          .from(deviceTokensTable)
          .where(eq(deviceTokensTable.token, input.token))
          .limit(1);
        if (race) return { row: rowToToken(race), errors: [] };
        return { row: null, errors: ["Failed to register push token."] };
      }

      return { row: rowToToken(created), errors: [] };
    },

    async remove(userId: string, token: string): Promise<boolean> {
      const numeric = numericUserId(userId);
      if (numeric == null) return false;
      const [existing] = await db
        .select()
        .from(deviceTokensTable)
        .where(eq(deviceTokensTable.token, token))
        .limit(1);
      if (!existing || existing.userId !== numeric) return false;
      await db.delete(deviceTokensTable).where(eq(deviceTokensTable.id, existing.id));
      return true;
    },

    async prune(tokens: string[]): Promise<number> {
      if (tokens.length === 0) return 0;
      const deleted = await db
        .delete(deviceTokensTable)
        .where(inArray(deviceTokensTable.token, tokens))
        .returning();
      return deleted.length;
    },

    async forUser(userId: string): Promise<DeviceTokenRow[]> {
      const numeric = numericUserId(userId);
      if (numeric == null) return [];
      const rows = await db
        .select()
        .from(deviceTokensTable)
        .where(eq(deviceTokensTable.userId, numeric))
        .orderBy(desc(deviceTokensTable.id));
      return rows.map(rowToToken);
    },

    /** No-op for parity: DB rows persist across requests (tests use memory). */
    reset(): void {},
  };
}

// ── Support (support_tickets + support_messages) ──────────────────────────

/**
 * SupportStore backed by `support_tickets` + `support_messages`.
 * Lifecycle transitions (createTicket, reply, setStatus) match the
 * in-memory store semantics exactly: reply/setStatus mutate the
 * caller-held TicketRow in place and persist.
 */
export function createDbSupportStore(): SupportStoreLike {
  type TktRow = typeof supportTickets.$inferSelect;
  type MsgRow = typeof supportMessages.$inferSelect;

  function rowToTicket(row: TktRow): TicketRow {
    return {
      id: row.id,
      ticketNumber: row.ticketNumber,
      userId: String(row.userId),
      subject: row.subject,
      category: row.category,
      priority: row.priority,
      status: row.status,
      platform: row.platform,
      lastMessage: row.lastMessage,
      lastMessageAt: toIso(row.lastMessageAt),
      assigneeId: row.assignedTo != null ? String(row.assignedTo) : null,
      resolvedAt: toIso(row.resolvedAt),
      closedAt: toIso(row.closedAt),
      createdAt: toIso(row.createdAt) ?? nowIso(),
    };
  }

  function rowToMessage(row: MsgRow): TicketMessageRow {
    return {
      id: row.id,
      ticketId: row.supportTicketId,
      userId: row.userId != null ? String(row.userId) : "0",
      senderType: row.senderType as TicketMessageRow["senderType"],
      message: row.message,
      readAt: toIso(row.readAt),
      createdAt: toIso(row.createdAt) ?? nowIso(),
    };
  }

  // Lazy-import constants + helper to avoid circular module-eval dependency.
  async function getSupportConstants() {
    const mod = await import("../modules/support/index");
    return {
      generateTicketNumber: mod.generateTicketNumber,
      TICKET_STATUSES: mod.TICKET_STATUSES,
      OWNER_SETTABLE_STATUSES: mod.OWNER_SETTABLE_STATUSES,
    };
  }

  return {
    async findTicket(
      userId: string,
      staff: boolean,
      id: number,
    ): Promise<TicketRow | undefined> {
      const [row] = await db
        .select()
        .from(supportTickets)
        .where(eq(supportTickets.id, id))
        .limit(1);
      if (!row) return undefined;
      if (!staff && String(row.userId) !== userId) return undefined;
      return rowToTicket(row);
    },

    async listFor(userId: string, staff: boolean): Promise<TicketRow[]> {
      if (staff) {
        const rows = await db
          .select()
          .from(supportTickets)
          .orderBy(desc(supportTickets.lastMessageAt));
        return rows.map(rowToTicket);
      }
      const numeric = numericUserId(userId);
      if (numeric == null) return [];
      const rows = await db
        .select()
        .from(supportTickets)
        .where(eq(supportTickets.userId, numeric))
        .orderBy(desc(supportTickets.lastMessageAt));
      return rows.map(rowToTicket);
    },

    async createTicket(
      userId: string,
      input: {
        subject: string;
        category?: string;
        priority?: string;
        message: string;
        platform?: string;
      },
    ): Promise<{ ticket: TicketRow; firstMessage: TicketMessageRow }> {
      const { generateTicketNumber } = await getSupportConstants();
      const numeric = numericUserId(userId);
      if (numeric == null) throw new Error(`Cannot persist support ticket: userId "${userId}" is not numeric.`);
      const now = new Date();
      const [ticketRow] = await db
        .insert(supportTickets)
        .values({
          ticketNumber: generateTicketNumber(),
          userId: numeric,
          subject: input.subject,
          category: (input.category ?? "general_inquiry") as typeof supportTickets.$inferInsert.category,
          priority: (input.priority ?? "normal") as typeof supportTickets.$inferInsert.priority,
          status: "open",
          platform: (input.platform ?? "unknown") as typeof supportTickets.$inferInsert.platform,
          lastMessage: input.message.slice(0, 250),
          lastMessageAt: now,
          assignedTo: null,
          resolvedAt: null,
          closedAt: null,
        })
        .returning();
      if (!ticketRow) throw new Error("support ticket insert returned no row");

      const [msgRow] = await db
        .insert(supportMessages)
        .values({
          supportTicketId: ticketRow.id,
          userId: numeric,
          senderType: "user",
          message: input.message,
          attachments: null,
        })
        .returning();
      if (!msgRow) throw new Error("support message insert returned no row");

      return { ticket: rowToTicket(ticketRow), firstMessage: rowToMessage(msgRow) };
    },

    async thread(ticketId: number): Promise<TicketMessageRow[]> {
      const rows = await db
        .select()
        .from(supportMessages)
        .where(eq(supportMessages.supportTicketId, ticketId))
        .orderBy(asc(supportMessages.id));
      return rows.map(rowToMessage);
    },

    async reply(
      ticket: TicketRow,
      userId: string,
      staff: boolean,
      message: string,
    ): Promise<{ reply: TicketMessageRow } | { error: string }> {
      if (ticket.status === "closed") {
        return { error: "This ticket is closed. Please open a new ticket." };
      }
      const numeric = numericUserId(userId);
      const senderType = staff ? "support" : "user";
      const now = new Date();

      const [msgRow] = await db
        .insert(supportMessages)
        .values({
          supportTicketId: ticket.id,
          userId: numeric,
          senderType,
          message,
          attachments: null,
        })
        .returning();

      // Transition logic (matches memory store exactly).
      if (senderType === "user" && ticket.status === "resolved") {
        ticket.status = "open";
        ticket.resolvedAt = null;
      } else if (senderType === "support" && ticket.status === "open") {
        ticket.status = "pending";
      }

      const lastMessage = message.slice(0, 250);
      ticket.lastMessage = lastMessage;
      ticket.lastMessageAt = now.toISOString();

      await db
        .update(supportTickets)
        .set({
          lastMessage,
          lastMessageAt: now,
          status: ticket.status as typeof supportTickets.$inferInsert.status,
          resolvedAt: ticket.resolvedAt != null ? toDate(ticket.resolvedAt) : null,
          closedAt: ticket.closedAt != null ? toDate(ticket.closedAt) : null,
        })
        .where(eq(supportTickets.id, ticket.id));

      return { reply: rowToMessage(msgRow!) };
    },

    async setStatus(
      ticket: TicketRow,
      userId: string,
      staff: boolean,
      status: string,
    ): Promise<{ ticket: TicketRow } | { error: string }> {
      const { TICKET_STATUSES, OWNER_SETTABLE_STATUSES } = await getSupportConstants();
      if (!(TICKET_STATUSES as readonly string[]).includes(status)) {
        return { error: `status must be one of: ${TICKET_STATUSES.join(", ")}.` };
      }
      if (!staff && !(OWNER_SETTABLE_STATUSES as readonly string[]).includes(status)) {
        return { error: "You can only resolve or close your own ticket." };
      }

      const now = new Date();
      ticket.status = status;
      ticket.resolvedAt = status === "resolved" ? now.toISOString() : null;
      ticket.closedAt = status === "closed" ? now.toISOString() : null;

      await db
        .update(supportTickets)
        .set({
          status: status as typeof supportTickets.$inferInsert.status,
          resolvedAt: ticket.resolvedAt != null ? toDate(ticket.resolvedAt) : null,
          closedAt: ticket.closedAt != null ? toDate(ticket.closedAt) : null,
        })
        .where(eq(supportTickets.id, ticket.id));

      return { ticket };
    },

    async markThreadRead(ticketId: number, viewerStaff: boolean): Promise<void> {
      const readTypes = viewerStaff ? ["user"] : ["support", "system"];
      await db
        .update(supportMessages)
        .set({ readAt: new Date() })
        .where(
          and(
            eq(supportMessages.supportTicketId, ticketId),
            inArray(supportMessages.senderType, readTypes as ("user" | "support" | "system")[]),
            isNull(supportMessages.readAt),
          ),
        );
    },

    /** No-op for parity: DB rows persist across requests (tests use memory). */
    reset(): void {},
  };
}

// ── Adverts (adverts) ─────────────────────────────────────────────────────

/**
 * AdvertStore backed by the `adverts` table.
 *
 * Field mapping (AdvertRow ↔ DB columns):
 *   imageUrl  → imagePath
 *   link      → targetUrl
 *   startsAt  → publishedAt
 *   endsAt    → expiresAt
 */
export function createDbAdvertStore(): AdvertStoreLike {
  type AdvRow = typeof advertsTable.$inferSelect;

  function rowToRow(row: AdvRow): AdvertRow {
    return {
      id: row.id,
      uuid: row.uuid,
      userId: String(row.userId),
      title: row.title,
      description: row.description,
      imageUrl: row.imagePath,
      link: row.targetUrl,
      startsAt: toIso(row.publishedAt),
      endsAt: toIso(row.expiresAt),
      status: row.status,
      createdAt: toIso(row.createdAt) ?? nowIso(),
    };
  }

  return {
    async submit(
      userId: string,
      input: {
        title: string;
        description?: string | null;
        image_url?: string | null;
        link?: string | null;
        starts_at?: string | null;
        ends_at?: string | null;
      },
    ): Promise<AdvertRow> {
      const numeric = numericUserId(userId);
      if (numeric == null) throw new Error(`Cannot persist advert: userId "${userId}" is not numeric.`);
      const [row] = await db
        .insert(advertsTable)
        .values({
          userId: numeric,
          title: input.title,
          description: input.description ?? null,
          imagePath: input.image_url ?? null,
          targetUrl: input.link ?? null,
          publishedAt: input.starts_at != null ? toDate(input.starts_at) : null,
          expiresAt: input.ends_at != null ? toDate(input.ends_at) : null,
          status: "pending",
        })
        .returning();
      if (!row) throw new Error("advert insert returned no row");
      return rowToRow(row);
    },

    async setStatus(id: number, status: string): Promise<AdvertRow | undefined> {
      const [row] = await db
        .update(advertsTable)
        .set({ status })
        .where(eq(advertsTable.id, id))
        .returning();
      return row ? rowToRow(row) : undefined;
    },

    async active(now: number = Date.now()): Promise<AdvertRow[]> {
      // Fetch all active adverts from DB, then filter isLive in JS to match
      // the memory store semantics (window checks on startsAt/endsAt).
      const rows = await db
        .select()
        .from(advertsTable)
        .where(eq(advertsTable.status, "active"))
        .orderBy(desc(advertsTable.createdAt));
      const mapped = rows.map(rowToRow);
      // Lazy-import isLive from the adverts module to avoid cycle at eval time.
      const { isLive } = await import("../modules/adverts/index");
      return mapped.filter((r) => isLive(r, now));
    },

    /** No-op for parity: DB rows persist across requests (tests use memory). */
    reset(): void {},
  };
}

// ── Referrals (referral_attributions) ─────────────────────────────────────

/**
 * ReferralStore backed by `referral_attributions`.
 *
 * Field mapping:
 *   code     → referralCode
 *   campaign → campaignId
 *   source   → stored inside metadata (no dedicated column)
 */
export function createDbReferralStore(): ReferralStoreLike {
  type RefRow = typeof referralAttributions.$inferSelect;

  function rowToRow(row: RefRow): AttributionRow {
    const meta = (row.metadata as Record<string, unknown>) ?? {};
    return {
      id: row.id,
      uuid: row.uuid,
      userId: row.userId != null ? String(row.userId) : null,
      code: row.referralCode,
      campaign: row.campaignId,
      source: (meta.__source as string) ?? null,
      status: row.status,
      metadata: meta,
      registeredAt: toIso(row.registeredAt),
      convertedAt: toIso(row.convertedAt),
      createdAt: toIso(row.createdAt) ?? nowIso(),
    };
  }

  return {
    async register(
      userId: string | null,
      input: {
        code?: string | null;
        campaign?: string | null;
        metadata?: Record<string, unknown>;
      },
    ): Promise<{ row: AttributionRow } | { errors: string[] }> {
      if (!input.code && !input.campaign) {
        return { errors: ["Either code or campaign is required."] };
      }
      if (input.code !== undefined && input.code !== null && input.code.length > 60) {
        return { errors: ["code must not exceed 60 characters."] };
      }

      const numeric = numericUserId(userId);
      const now = new Date();
      const meta = (input.metadata ?? {}) as Record<string, unknown>;

      const [row] = await db
        .insert(referralAttributions)
        .values({
          userId: numeric,
          referralCode: input.code ?? null,
          campaignId: input.campaign ?? null,
          metadata: meta,
          status: userId !== null ? "registered" : "pending",
          registeredAt: userId !== null ? now : null,
        })
        .returning();
      if (!row) throw new Error("referral attribution insert returned no row");
      return { row: rowToRow(row) };
    },

    async track(
      userId: string | null,
      input: {
        source?: string | null;
        campaign?: string | null;
        event?: string | null;
        attribution_id?: string | null;
        metadata?: Record<string, unknown>;
      },
    ): Promise<{ row: AttributionRow } | { errors: string[] }> {
      const numericUser = numericUserId(userId);

      if (input.attribution_id) {
        // Conversion path: look up by uuid or String(id).
        const numeric = numericUserId(input.attribution_id);
        const [existing] = await db
          .select()
          .from(referralAttributions)
          .where(
            numeric != null
              ? or(
                  eq(referralAttributions.uuid, input.attribution_id),
                  eq(referralAttributions.id, numeric),
                )
              : eq(referralAttributions.uuid, input.attribution_id),
          )
          .limit(1);
        if (!existing) return { errors: ["Attribution not found."] };

        const meta = (existing.metadata as Record<string, unknown>) ?? {};
        if (input.event) meta.last_event = input.event;
        Object.assign(meta, input.metadata ?? {});
        const now = new Date();
        await db
          .update(referralAttributions)
          .set({ status: "converted", convertedAt: now, metadata: meta })
          .where(eq(referralAttributions.id, existing.id));
        existing.status = "converted";
        existing.convertedAt = now;
        existing.metadata = meta;
        return { row: rowToRow(existing) };
      }

      if (!input.source) return { errors: ["source is required."] };

      const meta: Record<string, unknown> = { ...(input.event ? { last_event: input.event } : {}), ...(input.metadata ?? {}) };
      meta.__source = input.source;
      const now = new Date();

      const [row] = await db
        .insert(referralAttributions)
        .values({
          userId: numericUser,
          campaignId: input.campaign ?? null,
          metadata: meta,
          status: "converted",
          convertedAt: now,
        })
        .returning();
      if (!row) throw new Error("referral attribution insert returned no row");
      return { row: rowToRow(row) };
    },

    /** No-op for parity: DB rows persist across requests (tests use memory). */
    reset(): void {},
  };
}

// ── Safety (safety_reports) ───────────────────────────────────────────────

/**
 * SafetyStore backed by `safety_reports`.
 *
 * Field mapping:
 *   targetType → reportType
 *   details    → message
 *   targetId   → listingId (for listings) / reportedUserId (for users)
 *               (non-numeric/non-uuid targets are not persisted)
 */
export function createDbSafetyStore(): SafetyStoreLike {
  type SfRow = typeof safetyReports.$inferSelect;

  function rowToRow(row: SfRow): SafetyReportRow {
    return {
      id: row.id,
      uuid: row.uuid,
      reporterId: String(row.reporterId),
      targetType: row.reportType,
      targetId: row.listingId ?? (row.reportedUserId != null ? String(row.reportedUserId) : null),
      reason: "other", // not persisted as a separate column; see note below
      details: row.message,
      status: row.status,
      createdAt: toIso(row.createdAt) ?? nowIso(),
    };
  }

  return {
    async submit(
      reporterId: string,
      input: {
        target_type: string;
        target_id?: string | number | null;
        reason: string;
        details: string;
      },
    ): Promise<SafetyReportRow> {
      const numericReporter = numericUserId(reporterId);
      if (numericReporter == null) throw new Error(`Cannot persist safety report: userId "${reporterId}" is not numeric.`);

      // Map target to DB columns: listings go to listingId, users to reportedUserId.
      const targetStr = input.target_id == null ? null : String(input.target_id);
      const numericTarget = targetStr != null ? numericUserId(targetStr) : null;
      const isListing = input.target_type === "listing";
      const isUser = input.target_type === "user";

      const [row] = await db
        .insert(safetyReports)
        .values({
          reporterId: numericReporter,
          reportType: input.target_type,
          message: input.details,
          listingId: isListing && targetStr ? targetStr : null,
          reportedUserId: isUser && numericTarget ? numericTarget : null,
          status: "pending",
        })
        .returning();
      if (!row) throw new Error("safety report insert returned no row");

      // Construct row matching memory store shape; reason is not in DB so we
      // carry it in the response only (stored in-memory by the caller).
      const result: SafetyReportRow = rowToRow(row);
      result.reason = input.reason;
      return result;
    },

    /** No-op for parity: DB rows persist across requests (tests use memory). */
    reset(): void {},
  };
}

// ── Chat (chat_messages) ──────────────────────────────────────────────────

/**
 * ChatStore backed by `chat_messages`. Presence stays in-memory (ephemeral
 * by design — Firebase is the realtime source; there is no DB presence table).
 *
 * The route handlers must call `hydrate()` before `groupConversations()` /
 * `getHistory()` / `markConversationRead()` to ensure the in-memory cache
 * is populated from the DB. The memory ChatStore's `hydrate()` is a no-op.
 */
export function createDbChatStore(): ChatStoreLike {
  type DbChatRow = typeof chatMessages.$inferSelect;

  const messages: ChatMessageRow[] = [];
  const presence = new Map<string, PresenceRow>();

  function rowToRow(row: DbChatRow): ChatMessageRow {
    return {
      id: row.id,
      conversationId: row.conversationId,
      participantKey: row.participantKey,
      clientMessageId: row.clientMessageId,
      senderId: String(row.senderId),
      receiverId: String(row.receiverId),
      message: row.message,
      messageType: row.messageType as ChatMessageRow["messageType"],
      attachmentUrl: row.attachmentUrl,
      readAt: toIso(row.readAt),
      createdAt: toIso(row.createdAt) ?? nowIso(),
    };
  }

  return {
    messages,
    presence,

    async syncBatch(
      senderId: string,
      items: SyncMessageInput[],
    ): Promise<{ created: ChatMessageRow[]; duplicates: ChatMessageRow[]; errors: Array<{ index: number; error: string }> }> {
      // Reuse the module's validation + participant key so error messages and
      // clash semantics match the memory store exactly (no cycle at eval time).
      const { participantKeyFor, validateSyncItem } = await import("../modules/chat/index");
      const senderNum = numericUserId(senderId);

      const errors: Array<{ index: number; error: string }> = [];
      // Phase 1: validate all items (all-or-nothing on validation).
      items.forEach((item, index) => {
        const err = validateSyncItem(item, senderId);
        if (err) {
          errors.push({ index, error: err });
          return;
        }
        // Clash check: same conversation_id must map to the same participant pair.
        const expectedKey = participantKeyFor(senderId, item.receiver_id);
        if (senderNum != null) {
          const clash = messages.find(
            (m) => m.conversationId === item.conversation_id && m.participantKey !== expectedKey,
          );
          if (clash) errors.push({ index, error: "This conversation_id is already in use by another conversation." });
        }
      });
      if (errors.length > 0) return { created: [], duplicates: [], errors };

      const created: ChatMessageRow[] = [];
      const duplicates: ChatMessageRow[] = [];
      const now = new Date();

      for (const item of items) {
        const receiverNum = numericUserId(item.receiver_id);
        if (senderNum == null || receiverNum == null) {
          errors.push({ index: items.indexOf(item), error: "sender/receiver user id is not numeric." });
          continue;
        }
        const pk = participantKeyFor(senderId, item.receiver_id);

        // Dedupe: same (conversation_id, sender_id, client_message_id) is a replay
        // — look in the cache first, then the DB (cache is authoritative after hydrate).
        let existing = messages.find(
          (m) =>
            m.conversationId === item.conversation_id &&
            m.senderId === senderId &&
            m.clientMessageId === item.client_message_id,
        );
        if (!existing) {
          const [row] = await db
            .select()
            .from(chatMessages)
            .where(
              and(
                eq(chatMessages.conversationId, item.conversation_id),
                eq(chatMessages.senderId, senderNum),
                eq(chatMessages.clientMessageId, item.client_message_id),
              ),
            )
            .limit(1);
          existing = row ? rowToRow(row) : undefined;
        }

        if (existing) {
          if (!messages.includes(existing)) messages.push(existing);
          duplicates.push(existing);
          continue;
        }

        const [inserted] = await db
          .insert(chatMessages)
          .values({
            conversationId: item.conversation_id,
            participantKey: pk,
            clientMessageId: item.client_message_id,
            senderId: senderNum,
            receiverId: receiverNum,
            message: item.message ?? null,
            messageType: (item.message_type ?? "text") as typeof chatMessages.$inferInsert.messageType,
            attachmentUrl: item.attachment_url ?? null,
          })
          .returning();

        if (!inserted) {
          errors.push({ index: items.indexOf(item), error: "Failed to persist message." });
          continue;
        }

        const chatRow = rowToRow(inserted);
        messages.push(chatRow);
        created.push(chatRow);
      }

      return { created, duplicates, errors };
    },

    visibleTo(userId: string, staff: boolean): ChatMessageRow[] {
      if (staff) return messages;
      return messages.filter((m) => m.senderId === userId || m.receiverId === userId);
    },

    async hydrate(userId: string, staff: boolean = false): Promise<void> {
      messages.length = 0;
      if (staff) {
        const rows = await db
          .select()
          .from(chatMessages)
          .orderBy(desc(chatMessages.createdAt));
        messages.push(...rows.map(rowToRow));
      } else {
        const numeric = numericUserId(userId);
        if (numeric == null) return;
        const rows = await db
          .select()
          .from(chatMessages)
          .where(or(eq(chatMessages.senderId, numeric), eq(chatMessages.receiverId, numeric)))
          .orderBy(desc(chatMessages.createdAt));
        messages.push(...rows.map(rowToRow));
      }
    },

    async markConversationRead(userId: string, conversationId: string): Promise<number> {
      const numeric = numericUserId(userId);
      if (numeric == null) return 0;
      const now = new Date();
      // Update DB: mark all unread messages in this conversation where this user is receiver.
      const updated = await db
        .update(chatMessages)
        .set({ readAt: now })
        .where(
          and(
            eq(chatMessages.conversationId, conversationId),
            eq(chatMessages.receiverId, numeric),
            isNull(chatMessages.readAt),
          ),
        )
        .returning();
      // Sync in-memory cache.
      for (const m of messages) {
        if (m.conversationId === conversationId && m.receiverId === userId && m.readAt === null) {
          m.readAt = now.toISOString();
        }
      }
      return updated.length;
    },

    /** No-op for parity (DB rows persist; tests use memory). */
    reset(): void {},
  };
}
