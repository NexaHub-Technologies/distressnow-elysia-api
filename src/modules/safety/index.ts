// src/modules/safety/index.ts
//
// Safety reports — scam, fake listing, harassment, ...
//
// Mirrors DistressNowApi's SafetyReportController: the report is persisted
// for staff review (triage + admin notify happen in the review layer). The
// client contract is { target_type, target_id, reason, details }.
//
// Endpoint (mounted under /reports):
//   POST /reports/safety   { target_type, target_id?, reason, details }

import { Elysia, t } from "elysia";
import { pgTable, serial, integer, varchar, text, timestamp } from "drizzle-orm/pg-core";

// ── Drizzle contract (Postgres wiring seam; runtime uses in-memory store) ──

export const safetyReports = pgTable("safety_reports", {
  id: serial("id").primaryKey(),
  uuid: varchar("uuid", { length: 36 }).notNull().unique(),
  reporterId: integer("reporter_id").notNull(),
  reportType: varchar("report_type", { length: 40 }).notNull(),
  message: text("message").notNull(),
  listingId: varchar("listing_id", { length: 36 }),
  reportedUserId: integer("reported_user_id"),
  status: varchar("status", { length: 20 }).notNull().default("pending"),
});

// ── Constants ──────────────────────────────────────────────────────────────

export const SAFETY_TARGET_TYPES = ["listing", "user", "store", "message", "other"] as const;

export const SAFETY_REASONS = [
  "scam",
  "fake_listing",
  "harassment",
  "unsafe_meeting",
  "spam",
  "other",
] as const;

export const SAFETY_STATUSES = ["pending", "reviewing", "resolved", "dismissed"] as const;

// ── Types ──────────────────────────────────────────────────────────────────

export interface SafetyReportRow {
  id: number;
  uuid: string;
  reporterId: number;
  targetType: string;
  targetId: string | null;
  reason: string;
  details: string;
  status: string;
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

// ── Pure domain logic (unit-tested) ────────────────────────────────────────

export function validateSafetyReport(input: {
  target_type?: unknown;
  target_id?: unknown;
  reason?: unknown;
  details?: unknown;
}): string[] {
  const errors: string[] = [];
  if (typeof input.target_type !== "string" || !(SAFETY_TARGET_TYPES as readonly string[]).includes(input.target_type)) {
    errors.push(`target_type must be one of: ${SAFETY_TARGET_TYPES.join(", ")}.`);
  }
  if (input.target_id !== undefined && input.target_id !== null && input.target_id !== "") {
    if (typeof input.target_id !== "string" && typeof input.target_id !== "number") {
      errors.push("target_id must be a string or number.");
    }
  }
  if (typeof input.reason !== "string" || !(SAFETY_REASONS as readonly string[]).includes(input.reason)) {
    errors.push(`reason must be one of: ${SAFETY_REASONS.join(", ")}.`);
  }
  if (typeof input.details !== "string" || input.details.trim() === "") {
    errors.push("details is required.");
  } else if (input.details.length > 2000) {
    errors.push("details must not exceed 2000 characters.");
  }
  return errors;
}

export class SafetyStore {
  rows: SafetyReportRow[] = [];
  private seq = 1;

  reset(): void {
    this.rows = [];
    this.seq = 1;
  }

  submit(
    reporterId: number,
    input: { target_type: string; target_id?: string | number | null; reason: string; details: string },
  ): SafetyReportRow {
    const row: SafetyReportRow = {
      id: this.seq++,
      uuid: crypto.randomUUID(),
      reporterId,
      targetType: input.target_type,
      targetId: input.target_id === undefined || input.target_id === null ? null : String(input.target_id),
      reason: input.reason,
      details: input.details,
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    this.rows.push(row);
    return row;
  }
}

export const safetyStore = new SafetyStore();

// ── HTTP ───────────────────────────────────────────────────────────────────

export const safetyApp = new Elysia({ prefix: "/reports" })
  .derive(({ headers }) => ({ user: resolveUser(headers) }))

  .post(
    "/safety",
    ({ body, user, set }) => {
      const errors = validateSafetyReport(body);
      if (errors.length > 0) {
        set.status = 422;
        return fail("Safety report validation failed.", errors);
      }
      const report = safetyStore.submit(user.id, {
        target_type: body.target_type,
        target_id: body.target_id ?? null,
        reason: body.reason,
        details: body.details,
      });
      console.warn("[Safety] report submitted", {
        report_uuid: report.uuid,
        reason: report.reason,
        reporter_id: report.reporterId,
      });
      set.status = 201;
      return ok("Safety report submitted.", report);
    },
    {
      body: t.Object({
        target_type: t.String(),
        target_id: t.Optional(t.Union([t.String(), t.Number(), t.Null()])),
        reason: t.String(),
        details: t.String(),
      }),
    },
  );

export default safetyApp;
