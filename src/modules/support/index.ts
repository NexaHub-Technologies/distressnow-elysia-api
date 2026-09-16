// src/modules/support/index.ts
//
// Support ticketing — replaces the Firestore `supportTickets` collection.
//
// Every ticket lookup is scoped to the caller (staff see everything, users
// see only their own) and misses 404 rather than 403 so ticket IDs are not
// enumerable. The opening message becomes the first thread entry, so a
// ticket is never created without a body.
//
// Endpoints (mounted under /support):
//   GET   /support/tickets            inbox, newest activity first
//   POST  /support/tickets            open { subject, category, message }
//   GET   /support/tickets/:id        full thread (marks counterparty read)
//   POST  /support/tickets/:id/reply  append message
//   PATCH /support/tickets/:id/status owner: resolved|closed; staff: any
//
// Auth: real JWT guard (applyAuthGuard) resolving the shared UserStore.
// User ids are strings (see src/db/stores.ts); the DB table contract for
// support_tickets / support_messages lives in src/db/schema.ts.

import { Elysia, t } from "elysia";
import { applyAuthGuard, type UserStore } from "../auth/index";
import { getDbStores } from "../../db/stores";

// ── Constants (mirror SupportTicket model) ─────────────────────────────────

export const TICKET_CATEGORIES = [
  "general_inquiry",
  "report_issue",
  "account_services",
  "listing_issues",
  "verification_issues",
  "billing",
  "other",
] as const;

export const TICKET_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export const TICKET_STATUSES = ["open", "pending", "resolved", "closed"] as const;
export const OWNER_SETTABLE_STATUSES = ["resolved", "closed"] as const;

// ── Types ──────────────────────────────────────────────────────────────────

export interface TicketRow {
  id: number;
  ticketNumber: string;
  userId: string;
  subject: string;
  category: string;
  priority: string;
  status: string;
  platform: string;
  lastMessage: string | null;
  lastMessageAt: string | null;
  assigneeId: string | null;
  resolvedAt: string | null;
  closedAt: string | null;
  createdAt: string;
}

export interface TicketMessageRow {
  id: number;
  ticketId: number;
  userId: string;
  senderType: "user" | "support" | "system";
  message: string;
  readAt: string | null;
  createdAt: string;
}

function isStaff(user: { roles: string[] }): boolean {
  return user.roles.includes("admin") || user.roles.includes("verifier");
}

function ok(message: string, data: unknown = null, meta?: unknown) {
  return { success: true as const, message, data, ...(meta !== undefined ? { meta } : {}) };
}

function fail(message: string, errors?: unknown) {
  return { success: false as const, message, data: null, ...(errors !== undefined ? { errors } : {}) };
}

// ── Pure domain logic (unit-tested) ────────────────────────────────────────

export function generateTicketNumber(): string {
  return `DN-SUP-${Math.floor(1000 + Math.random() * 9000)}`;
}

export function validateTicketInput(input: {
  subject?: unknown;
  category?: unknown;
  message?: unknown;
  priority?: unknown;
}): string[] {
  const errors: string[] = [];
  if (typeof input.subject !== "string" || input.subject.trim() === "") {
    errors.push("subject is required.");
  } else if (input.subject.length > 255) {
    errors.push("subject must not exceed 255 characters.");
  }
  if (input.category !== undefined && !(TICKET_CATEGORIES as readonly string[]).includes(String(input.category))) {
    errors.push(`category must be one of: ${TICKET_CATEGORIES.join(", ")}.`);
  }
  if (input.priority !== undefined && !(TICKET_PRIORITIES as readonly string[]).includes(String(input.priority))) {
    errors.push(`priority must be one of: ${TICKET_PRIORITIES.join(", ")}.`);
  }
  if (typeof input.message !== "string" || input.message.trim() === "") {
    errors.push("message is required.");
  } else if (input.message.length > 5000) {
    errors.push("message must not exceed 5000 characters.");
  }
  return errors;
}

export class SupportStore {
  tickets: TicketRow[] = [];
  messages: TicketMessageRow[] = [];
  private ticketSeq = 1;
  private messageSeq = 1;

  reset(): void {
    this.tickets = [];
    this.messages = [];
    this.ticketSeq = 1;
    this.messageSeq = 1;
  }

  /** Scoped lookup — invisible tickets read as undefined (→ 404). */
  findTicket(userId: string, staff: boolean, id: number): TicketRow | undefined {
    const ticket = this.tickets.find((tk) => tk.id === id);
    if (!ticket) return undefined;
    if (!staff && ticket.userId !== userId) return undefined;
    return ticket;
  }

  createTicket(
    userId: string,
    input: { subject: string; category?: string; priority?: string; message: string; platform?: string },
  ): { ticket: TicketRow; firstMessage: TicketMessageRow } {
    const now = new Date().toISOString();
    const ticket: TicketRow = {
      id: this.ticketSeq++,
      ticketNumber: generateTicketNumber(),
      userId,
      subject: input.subject,
      category: input.category ?? "general_inquiry",
      priority: input.priority ?? "normal",
      status: "open",
      platform: input.platform ?? "unknown",
      lastMessage: input.message.slice(0, 250),
      lastMessageAt: now,
      assigneeId: null,
      resolvedAt: null,
      closedAt: null,
      createdAt: now,
    };
    this.tickets.push(ticket);
    const firstMessage: TicketMessageRow = {
      id: this.messageSeq++,
      ticketId: ticket.id,
      userId,
      senderType: "user",
      message: input.message,
      readAt: null,
      createdAt: now,
    };
    this.messages.push(firstMessage);
    return { ticket, firstMessage };
  }

  thread(ticketId: number): TicketMessageRow[] {
    return this.messages.filter((m) => m.ticketId === ticketId).sort((a, b) => a.id - b.id);
  }

  reply(
    ticket: TicketRow,
    userId: string,
    staff: boolean,
    message: string,
  ): { reply: TicketMessageRow } | { error: string } {
    if (ticket.status === "closed") {
      return { error: "This ticket is closed. Please open a new ticket." };
    }
    const now = new Date().toISOString();
    const senderType = staff ? "support" : "user";
    const reply: TicketMessageRow = {
      id: this.messageSeq++,
      ticketId: ticket.id,
      userId,
      senderType,
      message,
      readAt: null,
      createdAt: now,
    };
    this.messages.push(reply);
    ticket.lastMessage = message.slice(0, 250);
    ticket.lastMessageAt = now;
    // A user following up on a resolved ticket reopens it; a staff reply
    // moves an open ticket to pending.
    if (senderType === "user" && ticket.status === "resolved") {
      ticket.status = "open";
      ticket.resolvedAt = null;
    } else if (senderType === "support" && ticket.status === "open") {
      ticket.status = "pending";
    }
    return { reply };
  }

  setStatus(
    ticket: TicketRow,
    userId: string,
    staff: boolean,
    status: string,
  ): { ticket: TicketRow } | { error: string } {
    if (!(TICKET_STATUSES as readonly string[]).includes(status)) {
      return { error: `status must be one of: ${TICKET_STATUSES.join(", ")}.` };
    }
    if (!staff && !(OWNER_SETTABLE_STATUSES as readonly string[]).includes(status)) {
      return { error: "You can only resolve or close your own ticket." };
    }
    ticket.status = status;
    ticket.resolvedAt = status === "resolved" ? new Date().toISOString() : null;
    ticket.closedAt = status === "closed" ? new Date().toISOString() : null;
    return { ticket };
  }

  /** Opening a thread marks the counterparty's messages read (badge driver). */
  markThreadRead(ticketId: number, viewerStaff: boolean): void {
    const readTypes = viewerStaff ? ["user"] : ["support", "system"];
    const now = new Date().toISOString();
    for (const m of this.messages) {
      if (m.ticketId === ticketId && readTypes.includes(m.senderType) && m.readAt === null) {
        m.readAt = now;
      }
    }
  }
}

export const supportStore = new SupportStore();

// ── HTTP ───────────────────────────────────────────────────────────────────

const ticketBody = t.Object({
  subject: t.String(),
  category: t.Optional(t.String()),
  priority: t.Optional(t.String()),
  message: t.String(),
  platform: t.Optional(t.String()),
});

export interface SupportPluginOptions {
  users?: UserStore;
  secret?: string;
}

export function createSupportPlugin(options: SupportPluginOptions = {}) {
  return applyAuthGuard(new Elysia({ prefix: "/support" }), {
    secret: options.secret,
    users: options.users ?? getDbStores()?.users,
  })

    .get(
      "/tickets",
      ({ query, currentUser }) => {
        const staff = isStaff(currentUser);
        const page = Math.max(Number(query.page ?? "1") || 1, 1);
        const perPage = Math.min(Math.max(Number(query.per_page ?? "20") || 20, 1), 100);
        let rows = supportStore.tickets.filter((tk) => staff || tk.userId === currentUser.id);
      if (query.status) rows = rows.filter((tk) => tk.status === query.status);
      if (query.category) rows = rows.filter((tk) => tk.category === query.category);
      rows = rows.sort((a, b) => (a.lastMessageAt ?? a.createdAt) < (b.lastMessageAt ?? b.createdAt) ? 1 : -1);
      const total = rows.length;
      const items = rows.slice((page - 1) * perPage, page * perPage);
      return ok("Tickets retrieved.", items, {
        page,
        per_page: perPage,
        total,
        total_pages: Math.max(1, Math.ceil(total / perPage)),
      });
    },
    {
      query: t.Object({
        page: t.Optional(t.String()),
        per_page: t.Optional(t.String()),
        status: t.Optional(t.String()),
        category: t.Optional(t.String()),
      }),
    },
  )

  .post("/tickets", ({ body, currentUser, set }) => {
    const errors = validateTicketInput(body);
    if (errors.length > 0) {
      set.status = 422;
      return fail("Ticket validation failed.", errors);
    }
    const { ticket } = supportStore.createTicket(currentUser.id, {
      subject: body.subject,
      category: body.category,
      priority: body.priority,
      message: body.message,
      platform: body.platform,
    });
    set.status = 201;
    return ok("Support ticket created. Our team will respond shortly.", ticket);
  }, { body: ticketBody })

  .get("/tickets/:id", ({ params, currentUser, set }) => {
    const staff = isStaff(currentUser);
    const ticket = supportStore.findTicket(currentUser.id, staff, Number(params.id));
    if (!ticket) {
      set.status = 404;
      return fail("Ticket not found.");
    }
    supportStore.markThreadRead(ticket.id, staff);
    return ok("Ticket retrieved.", { ticket, messages: supportStore.thread(ticket.id) });
  }, { params: t.Object({ id: t.String() }) })

  .post(
    "/tickets/:id/reply",
    ({ params, body, currentUser, set }) => {
      const staff = isStaff(currentUser);
      const ticket = supportStore.findTicket(currentUser.id, staff, Number(params.id));
      if (!ticket) {
        set.status = 404;
        return fail("Ticket not found.");
      }
      if (typeof body.message !== "string" || body.message.trim() === "" || body.message.length > 5000) {
        set.status = 422;
        return fail("message is required (max 5000 characters).");
      }
      const result = supportStore.reply(ticket, currentUser.id, staff, body.message);
      if ("error" in result) {
        set.status = 422;
        return fail(result.error);
      }
      set.status = 201;
      return ok("Reply sent.", result.reply, { ticket_status: ticket.status });
    },
    { params: t.Object({ id: t.String() }), body: t.Object({ message: t.String() }) },
  )

  .patch(
    "/tickets/:id/status",
    ({ params, body, currentUser, set }) => {
      const staff = isStaff(currentUser);
      const ticket = supportStore.findTicket(currentUser.id, staff, Number(params.id));
      if (!ticket) {
        set.status = 404;
        return fail("Ticket not found.");
      }
      const result = supportStore.setStatus(ticket, currentUser.id, staff, body.status);
      if ("error" in result) {
        set.status = 422;
        return fail(result.error);
      }
      return ok(`Ticket ${ticket.ticketNumber} is now ${ticket.status}.`, ticket);
    },
    { params: t.Object({ id: t.String() }), body: t.Object({ status: t.String() }) },
  );
}

/** Default singleton plugin (real JWT guard; shared UserStore). */
export const supportApp = createSupportPlugin();

export default supportApp;
