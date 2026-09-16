// src/modules/adverts/index.ts
//
// Adverts — public showcase feed plus submission for review.
//
// Mirrors DistressNowApi's AdvertController: GET /adverts/active is PUBLIC
// (app display surface, latest published first); POST /adverts submits for
// review with status `pending` — publishing is a staff action elsewhere.
//
// Endpoints (mounted under /adverts):
//   GET  /adverts/active   public, only live ads
//   POST /adverts          auth, { title, image_url, link, starts_at, ends_at }
//
// Auth: optional JWT guard (applyOptionalAuth). GET /active stays public;
// POST requires a caller (rejects 401 otherwise). User ids are strings
// (see src/db/stores.ts); the DB table contract lives in src/db/schema.ts.

import { Elysia, t } from "elysia";
import { applyOptionalAuth, type UserStore } from "../auth/index";
import { getDbStores } from "../../db/stores";

// ── Types ──────────────────────────────────────────────────────────────────

export const ADVERT_STATUSES = ["pending", "active", "expired", "unpublished"] as const;

export interface AdvertRow {
  id: number;
  uuid: string;
  userId: string;
  title: string;
  description: string | null;
  imageUrl: string | null;
  link: string | null;
  startsAt: string | null;
  endsAt: string | null;
  status: string;
  createdAt: string;
}

function ok(message: string, data: unknown = null, meta?: unknown) {
  return { success: true as const, message, data, ...(meta !== undefined ? { meta } : {}) };
}

function fail(message: string, errors?: unknown) {
  return { success: false as const, message, data: null, ...(errors !== undefined ? { errors } : {}) };
}

function isUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

// ── Pure domain logic (unit-tested) ────────────────────────────────────────

export function validateAdvertInput(input: {
  title?: unknown;
  description?: unknown;
  image_url?: unknown;
  link?: unknown;
  starts_at?: unknown;
  ends_at?: unknown;
}): string[] {
  const errors: string[] = [];
  if (typeof input.title !== "string" || input.title.trim() === "") {
    errors.push("title is required.");
  } else if (input.title.length > 255) {
    errors.push("title must not exceed 255 characters.");
  }
  if (input.description !== undefined && input.description !== null) {
    if (typeof input.description !== "string" || input.description.length > 2000) {
      errors.push("description must be a string of at most 2000 characters.");
    }
  }
  if (input.image_url !== undefined && input.image_url !== null && input.image_url !== "") {
    if (typeof input.image_url !== "string" || !isUrl(input.image_url)) {
      errors.push("image_url must be a valid URL.");
    }
  }
  if (input.link !== undefined && input.link !== null && input.link !== "") {
    if (typeof input.link !== "string" || !isUrl(input.link)) {
      errors.push("link must be a valid URL.");
    }
  }
  let starts: number | null = null;
  let ends: number | null = null;
  if (input.starts_at !== undefined && input.starts_at !== null && input.starts_at !== "") {
    starts = Date.parse(String(input.starts_at));
    if (Number.isNaN(starts)) errors.push("starts_at must be a valid date.");
  }
  if (input.ends_at !== undefined && input.ends_at !== null && input.ends_at !== "") {
    ends = Date.parse(String(input.ends_at));
    if (Number.isNaN(ends)) errors.push("ends_at must be a valid date.");
  }
  if (starts !== null && ends !== null && !Number.isNaN(starts) && !Number.isNaN(ends) && ends <= starts) {
    errors.push("ends_at must be after starts_at.");
  }
  return errors;
}

/** Live = published window open and status active (mirrors scopeActive). */
export function isLive(advert: AdvertRow, now: number = Date.now()): boolean {
  if (advert.status !== "active") return false;
  if (advert.startsAt !== null && Date.parse(advert.startsAt) > now) return false;
  if (advert.endsAt !== null && Date.parse(advert.endsAt) <= now) return false;
  return true;
}

export class AdvertStore {
  rows: AdvertRow[] = [];
  private seq = 1;

  reset(): void {
    this.rows = [];
    this.seq = 1;
  }

  submit(
    userId: string,
    input: { title: string; description?: string | null; image_url?: string | null; link?: string | null; starts_at?: string | null; ends_at?: string | null },
  ): AdvertRow {
    const row: AdvertRow = {
      id: this.seq++,
      uuid: crypto.randomUUID(),
      userId,
      title: input.title,
      description: input.description ?? null,
      imageUrl: input.image_url ?? null,
      link: input.link ?? null,
      startsAt: input.starts_at ?? null,
      endsAt: input.ends_at ?? null,
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    this.rows.push(row);
    return row;
  }

  /** Test/staff seam: flip status without the review controller. */
  setStatus(id: number, status: string): AdvertRow | undefined {
    const row = this.rows.find((r) => r.id === id);
    if (row) row.status = status;
    return row;
  }

  active(now: number = Date.now()): AdvertRow[] {
    return this.rows.filter((r) => isLive(r, now)).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }
}

export const advertStore = new AdvertStore();

/**
 * Store surface consumed by the route handlers. Returns are widened to
 * `T | Promise<T>` so the DB-backed overlay (createDbAdvertStore) can
 * implement the same shape as the in-memory AdvertStore.
 */
export interface AdvertStoreLike {
  submit(
    userId: string,
    input: { title: string; description?: string | null; image_url?: string | null; link?: string | null; starts_at?: string | null; ends_at?: string | null },
  ): AdvertRow | Promise<AdvertRow>;
  setStatus(id: number, status: string): AdvertRow | undefined | Promise<AdvertRow | undefined>;
  active(now?: number): AdvertRow[] | Promise<AdvertRow[]>;
  reset(): void | Promise<void>;
}

// ── HTTP ───────────────────────────────────────────────────────────────────

const advertBody = t.Object({
  title: t.String(),
  description: t.Optional(t.Union([t.String(), t.Null()])),
  image_url: t.Optional(t.Union([t.String(), t.Null()])),
  link: t.Optional(t.Union([t.String(), t.Null()])),
  starts_at: t.Optional(t.Union([t.String(), t.Null()])),
  ends_at: t.Optional(t.Union([t.String(), t.Null()])),
});

export interface AdvertsPluginOptions {
  users?: UserStore;
  secret?: string;
  /** Advert store (memory default; DB-backed in production). */
  store?: AdvertStoreLike;
}

export function createAdvertsPlugin(options: AdvertsPluginOptions = {}) {
  const store = options.store ?? getDbStores()?.adverts ?? advertStore;

  return applyOptionalAuth(new Elysia({ prefix: "/adverts" }), {
    secret: options.secret,
    users: options.users ?? getDbStores()?.users,
  })

    // Public — the app display surface needs no token.
    .get(
      "/active",
      async ({ query }) => {
        const page = Math.max(Number(query.page ?? "1") || 1, 1);
        const perPage = Math.min(Math.max(Number(query.per_page ?? "20") || 20, 1), 100);
        const rows = await store.active();
        const total = rows.length;
        return ok("Active adverts retrieved.", rows.slice((page - 1) * perPage, page * perPage), {
          page,
          per_page: perPage,
          total,
          total_pages: Math.max(1, Math.ceil(total / perPage)),
        });
      },
      { query: t.Object({ page: t.Optional(t.String()), per_page: t.Optional(t.String()) }) },
    )

    .post("/", async ({ body, currentUser, set }) => {
      if (!currentUser) {
        set.status = 401;
        return fail("Unauthenticated.");
      }
      const errors = validateAdvertInput(body);
      if (errors.length > 0) {
        set.status = 422;
        return fail("Advert validation failed.", errors);
      }
      const advert = await store.submit(currentUser.id, {
        title: body.title,
        description: body.description ?? null,
        image_url: body.image_url ?? null,
        link: body.link ?? null,
        starts_at: body.starts_at ?? null,
        ends_at: body.ends_at ?? null,
      });
      set.status = 201;
      return ok("Advert submitted for review.", advert);
    }, { body: advertBody });
}

/** Default singleton plugin (optional JWT guard; shared UserStore). */
export const advertsApp = createAdvertsPlugin();

export default advertsApp;
