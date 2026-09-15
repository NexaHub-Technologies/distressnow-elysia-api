// src/modules/referrals/index.ts
//
// Referral attribution — install/invite tracking and conversion events.
//
// Mirrors DistressNowApi's ReferralController with the simplified client
// contract: register takes a referral { code } (or campaign), attribution
// takes { source, campaign } plus an optional event. Lifecycle:
// pending → registered → converted.
//
// Endpoints (mounted under /referrals):
//   POST /referrals/register     { code?, campaign?, metadata? }
//   POST /referrals/attribution  { source, campaign?, event?, attribution_id?, metadata? }

import { Elysia, t } from "elysia";
import { pgTable, serial, integer, varchar, timestamp, jsonb } from "drizzle-orm/pg-core";

// ── Drizzle contract (Postgres wiring seam; runtime uses in-memory store) ──

export const referralAttributions = pgTable("referral_attributions", {
  id: serial("id").primaryKey(),
  uuid: varchar("uuid", { length: 36 }).notNull().unique(),
  userId: integer("user_id"),
  referralCode: varchar("referral_code", { length: 60 }),
  campaignId: varchar("campaign_id", { length: 60 }),
  status: varchar("status", { length: 20 }).notNull().default("pending"),
  registeredUserId: integer("registered_user_id"),
  metadata: jsonb("metadata"),
  registeredAt: timestamp("registered_at"),
  convertedAt: timestamp("converted_at"),
});

// ── Types ──────────────────────────────────────────────────────────────────

export const REFERRAL_STATUSES = ["pending", "registered", "converted"] as const;

export interface AttributionRow {
  id: number;
  uuid: string;
  userId: number | null;
  code: string | null;
  campaign: string | null;
  source: string | null;
  status: string;
  metadata: Record<string, unknown>;
  registeredAt: string | null;
  convertedAt: string | null;
  createdAt: string;
}

export interface AuthUser {
  id: number;
  name: string;
  roles: string[];
}

function resolveUser(headers: Record<string, string | undefined>): AuthUser | null {
  const raw = headers["x-user-id"];
  if (raw === undefined || raw === "") {
    // Register may be called pre-signup (invite link opened); allow anonymous.
    return null;
  }
  const id = Number(raw);
  if (!Number.isFinite(id) || id <= 0) return null;
  const role = headers["x-user-role"];
  return { id, name: headers["x-user-name"] ?? "Test User", roles: role ? [role] : [] };
}

function fallbackUser(): AuthUser {
  return { id: 1, name: "Test User", roles: [] };
}

function ok(message: string, data: unknown = null, meta?: unknown) {
  return { success: true as const, message, data, ...(meta !== undefined ? { meta } : {}) };
}

function fail(message: string, errors?: unknown) {
  return { success: false as const, message, data: null, ...(errors !== undefined ? { errors } : {}) };
}

// ── Pure domain logic (unit-tested) ────────────────────────────────────────

export class ReferralStore {
  rows: AttributionRow[] = [];
  private seq = 1;

  reset(): void {
    this.rows = [];
    this.seq = 1;
  }

  register(
    userId: number | null,
    input: { code?: string | null; campaign?: string | null; metadata?: Record<string, unknown> },
  ): { row: AttributionRow } | { errors: string[] } {
    if (!input.code && !input.campaign) {
      return { errors: ["Either code or campaign is required."] };
    }
    if (input.code !== undefined && input.code !== null && input.code.length > 60) {
      return { errors: ["code must not exceed 60 characters."] };
    }
    const now = new Date().toISOString();
    const row: AttributionRow = {
      id: this.seq++,
      uuid: crypto.randomUUID(),
      userId,
      code: input.code ?? null,
      campaign: input.campaign ?? null,
      source: null,
      status: userId !== null ? "registered" : "pending",
      metadata: input.metadata ?? {},
      registeredAt: userId !== null ? now : null,
      convertedAt: null,
      createdAt: now,
    };
    this.rows.push(row);
    return { row };
  }

  track(
    userId: number | null,
    input: { source?: string | null; campaign?: string | null; event?: string | null; attribution_id?: string | null; metadata?: Record<string, unknown> },
  ): { row: AttributionRow } | { errors: string[] } {
    // Conversion against a known attribution (invited user acted).
    if (input.attribution_id) {
      const existing = this.rows.find((r) => r.uuid === input.attribution_id || String(r.id) === input.attribution_id);
      if (!existing) return { errors: ["Attribution not found."] };
      existing.status = "converted";
      existing.convertedAt = new Date().toISOString();
      existing.metadata = {
        ...existing.metadata,
        ...(input.event ? { last_event: input.event } : {}),
        ...(input.metadata ?? {}),
      };
      return { row: existing };
    }
    if (!input.source) return { errors: ["source is required."] };
    const now = new Date().toISOString();
    const row: AttributionRow = {
      id: this.seq++,
      uuid: crypto.randomUUID(),
      userId,
      code: null,
      campaign: input.campaign ?? null,
      source: input.source,
      status: "converted",
      metadata: { ...(input.event ? { last_event: input.event } : {}), ...(input.metadata ?? {}) },
      registeredAt: null,
      convertedAt: now,
      createdAt: now,
    };
    this.rows.push(row);
    return { row };
  }
}

export const referralStore = new ReferralStore();

// ── HTTP ───────────────────────────────────────────────────────────────────

export const referralsApp = new Elysia({ prefix: "/referrals" })
  .derive(({ headers }) => ({ authUser: resolveUser(headers) }))

  .post(
    "/register",
    ({ body, authUser, set }) => {
      const user = authUser ?? (body.user_id !== undefined && body.user_id !== null ? { id: body.user_id, name: "Test User", roles: [] as string[] } : null);
      const result = referralStore.register(user?.id ?? null, {
        code: body.code ?? null,
        campaign: body.campaign ?? null,
        metadata: body.metadata ?? {},
      });
      if ("errors" in result) {
        set.status = 422;
        return fail("Referral registration failed.", result.errors);
      }
      set.status = 201;
      return ok("Referral registered.", result.row);
    },
    {
      body: t.Object({
        code: t.Optional(t.Union([t.String({ maxLength: 60 }), t.Null()])),
        campaign: t.Optional(t.Union([t.String({ maxLength: 60 }), t.Null()])),
        user_id: t.Optional(t.Union([t.Number(), t.Null()])),
        metadata: t.Optional(t.Record(t.String(), t.Any())),
      }),
    },
  )

  .post(
    "/attribution",
    ({ body, authUser, set }) => {
      const user = authUser ?? fallbackUser();
      const result = referralStore.track(user.id, {
        source: body.source ?? null,
        campaign: body.campaign ?? null,
        event: body.event ?? null,
        attribution_id: body.attribution_id ?? null,
        metadata: body.metadata ?? {},
      });
      if ("errors" in result) {
        const missing = result.errors.includes("Attribution not found.");
        set.status = missing ? 404 : 422;
        return fail("Attribution tracking failed.", result.errors);
      }
      return ok("Attribution tracked.", result.row);
    },
    {
      body: t.Object({
        source: t.Optional(t.Union([t.String({ maxLength: 120 }), t.Null()])),
        campaign: t.Optional(t.Union([t.String({ maxLength: 60 }), t.Null()])),
        event: t.Optional(t.Union([t.String({ maxLength: 60 }), t.Null()])),
        attribution_id: t.Optional(t.Union([t.String(), t.Null()])),
        metadata: t.Optional(t.Record(t.String(), t.Any())),
      }),
    },
  );

export default referralsApp;
