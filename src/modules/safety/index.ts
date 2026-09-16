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
//
// Auth: real JWT guard (applyAuthGuard) resolving the shared UserStore.
// User ids are strings (see src/db/stores.ts); the DB table contract for
// safety_reports lives in src/db/schema.ts.

import { Elysia, t } from "elysia";
import { applyAuthGuard, type UserStore } from "../auth/index";
import { getDbStores } from "../../db/stores";

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
  reporterId: string;
  targetType: string;
  targetId: string | null;
  reason: string;
  details: string;
  status: string;
  createdAt: string;
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
    reporterId: string,
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

/**
 * Store surface consumed by the route handlers. Returns are widened to
 * `T | Promise<T>` so the DB-backed overlay (createDbSafetyStore) can
 * implement the same shape as the in-memory SafetyStore.
 */
export interface SafetyStoreLike {
  submit(
    reporterId: string,
    input: { target_type: string; target_id?: string | number | null; reason: string; details: string },
  ): SafetyReportRow | Promise<SafetyReportRow>;
  reset(): void | Promise<void>;
}

// ── HTTP ───────────────────────────────────────────────────────────────────

export interface SafetyPluginOptions {
  users?: UserStore;
  secret?: string;
  /** Safety report store (memory default; DB-backed in production). */
  store?: SafetyStoreLike;
}

export function createSafetyPlugin(options: SafetyPluginOptions = {}) {
  const store = options.store ?? getDbStores()?.safety ?? safetyStore;

  return applyAuthGuard(new Elysia({ prefix: "/reports" }), {
    secret: options.secret,
    users: options.users ?? getDbStores()?.users,
  })

    .post(
      "/safety",
      async ({ body, currentUser, set }) => {
        const errors = validateSafetyReport(body);
        if (errors.length > 0) {
          set.status = 422;
          return fail("Safety report validation failed.", errors);
        }
        const report = await store.submit(currentUser.id, {
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
}

/** Default singleton plugin (real JWT guard; shared UserStore). */
export const safetyApp = createSafetyPlugin();

export default safetyApp;
