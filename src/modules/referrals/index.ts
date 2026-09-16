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
//
// Auth: optional JWT guard (applyOptionalAuth). /register stays reachable
// for pre-signup invite links (anonymous caller gets `userId: null`); the
// body's `user_id` is accepted for legacy clients. /attribution REQUIRES a
// caller (security: removes the former fallback to user 1).
// User ids are strings (see src/db/stores.ts); the DB table contract for
// referral_attributions lives in src/db/schema.ts.

import { Elysia, t } from "elysia";
import { applyOptionalAuth, type UserStore } from "../auth/index";
import { getDbStores } from "../../db/stores";

// ── Types ──────────────────────────────────────────────────────────────────

export const REFERRAL_STATUSES = ["pending", "registered", "converted"] as const;

export interface AttributionRow {
  id: number;
  uuid: string;
  userId: string | null;
  code: string | null;
  campaign: string | null;
  source: string | null;
  status: string;
  metadata: Record<string, unknown>;
  registeredAt: string | null;
  convertedAt: string | null;
  createdAt: string;
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
    userId: string | null,
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
    userId: string | null,
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

/**
 * Store surface consumed by the route handlers. Returns are widened to
 * `T | Promise<T>` so the DB-backed overlay (createDbReferralStore) can
 * implement the same shape as the in-memory ReferralStore.
 */
export interface ReferralStoreLike {
  register(
    userId: string | null,
    input: { code?: string | null; campaign?: string | null; metadata?: Record<string, unknown> },
  ):
    | { row: AttributionRow }
    | { errors: string[] }
    | Promise<{ row: AttributionRow } | { errors: string[] }>;
  track(
    userId: string | null,
    input: { source?: string | null; campaign?: string | null; event?: string | null; attribution_id?: string | null; metadata?: Record<string, unknown> },
  ):
    | { row: AttributionRow }
    | { errors: string[] }
    | Promise<{ row: AttributionRow } | { errors: string[] }>;
  reset(): void | Promise<void>;
}

// ── HTTP ───────────────────────────────────────────────────────────────────

export interface ReferralsPluginOptions {
  users?: UserStore;
  secret?: string;
  /** Referral store (memory default; DB-backed in production). */
  store?: ReferralStoreLike;
}

export function createReferralsPlugin(options: ReferralsPluginOptions = {}) {
  const store = options.store ?? getDbStores()?.referrals ?? referralStore;

  return applyOptionalAuth(new Elysia({ prefix: "/referrals" }), {
    secret: options.secret,
    users: options.users ?? getDbStores()?.users,
  })

    .post(
      "/register",
      async ({ body, currentUser, set }) => {
        // Pre-signup invite links: anonymous caller OR body.user_id (legacy).
        const userId = currentUser?.id ?? (body.user_id !== undefined && body.user_id !== null ? String(body.user_id) : null);
        const result = await store.register(userId, {
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
      async ({ body, currentUser, set }) => {
        if (!currentUser) {
          set.status = 401;
          return fail("Unauthenticated.");
        }
        const result = await store.track(currentUser.id, {
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
}

/** Default singleton plugin (optional JWT guard; shared UserStore). */
export const referralsApp = createReferralsPlugin();

export default referralsApp;
