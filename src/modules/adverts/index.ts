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

import { Elysia, t } from "elysia";
import { pgTable, serial, integer, varchar, text, timestamp, numeric } from "drizzle-orm/pg-core";

// ── Drizzle contract (Postgres wiring seam; runtime uses in-memory store) ──

export const adverts = pgTable("adverts", {
  id: serial("id").primaryKey(),
  uuid: varchar("uuid", { length: 36 }).notNull().unique(),
  userId: integer("user_id").notNull(),
  title: varchar("title", { length: 255 }).notNull(),
  description: text("description"),
  imagePath: varchar("image_path", { length: 2048 }),
  targetUrl: varchar("target_url", { length: 500 }),
  durationDays: integer("duration_days").notNull().default(7),
  status: varchar("status", { length: 20 }).notNull().default("pending"),
  amountPaid: numeric("amount_paid", { precision: 10, scale: 2 }).default("0"),
  publishedAt: timestamp("published_at"),
  expiresAt: timestamp("expires_at"),
});

// ── Types ──────────────────────────────────────────────────────────────────

export const ADVERT_STATUSES = ["pending", "active", "expired", "unpublished"] as const;

export interface AdvertRow {
  id: number;
  uuid: string;
  userId: number;
  title: string;
  description: string | null;
  imageUrl: string | null;
  link: string | null;
  startsAt: string | null;
  endsAt: string | null;
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
    userId: number,
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

// ── HTTP ───────────────────────────────────────────────────────────────────

const advertBody = t.Object({
  title: t.String(),
  description: t.Optional(t.Union([t.String(), t.Null()])),
  image_url: t.Optional(t.Union([t.String(), t.Null()])),
  link: t.Optional(t.Union([t.String(), t.Null()])),
  starts_at: t.Optional(t.Union([t.String(), t.Null()])),
  ends_at: t.Optional(t.Union([t.String(), t.Null()])),
});

export const advertsApp = new Elysia({ prefix: "/adverts" })
  .derive(({ headers }) => ({ user: resolveUser(headers) }))

  // Public — the app display surface needs no token.
  .get(
    "/active",
    ({ query }) => {
      const page = Math.max(Number(query.page ?? "1") || 1, 1);
      const perPage = Math.min(Math.max(Number(query.per_page ?? "20") || 20, 1), 100);
      const rows = advertStore.active();
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

  .post("/", ({ body, user, set }) => {
    const errors = validateAdvertInput(body);
    if (errors.length > 0) {
      set.status = 422;
      return fail("Advert validation failed.", errors);
    }
    const advert = advertStore.submit(user.id, {
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

export default advertsApp;
