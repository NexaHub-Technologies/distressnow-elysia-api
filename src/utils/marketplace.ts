/**
 * Shared marketplace helpers.
 *
 * Everything in this file is pure (no DB, no framework) so it can be
 * unit-tested with bun:test. Route modules import from here to keep the
 * `{ data, meta }` envelope and validation rules consistent.
 */

/** URL-safe slug, e.g. "iPhone 12 Pro!!" -> "iphone-12-pro". */
export function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

export interface Pagination {
  page: number;
  perPage: number;
  limit: number;
  offset: number;
}

const DEFAULT_PER_PAGE = 20;
const MAX_PER_PAGE = 100;

/** Coerce unknown input to a positive integer, falling back when invalid. */
export function toPositiveInt(value: unknown, fallback: number): number {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : NaN;
  return Number.isInteger(n) && (n as number) > 0 ? (n as number) : fallback;
}

/** Normalise `page` / `per_page` query input (accepts strings from Elysia). */
export function buildPagination(
  pageInput?: unknown,
  perPageInput?: unknown,
  options?: { defaultPerPage?: number; maxPerPage?: number },
): Pagination {
  const max = options?.maxPerPage ?? MAX_PER_PAGE;
  const def = options?.defaultPerPage ?? DEFAULT_PER_PAGE;
  const page = toPositiveInt(pageInput, 1);
  const perPage = Math.min(toPositiveInt(perPageInput, def), max);
  return { page, perPage, limit: perPage, offset: (page - 1) * perPage };
}

export interface PageMeta {
  page: number;
  per_page: number;
  total: number;
  last_page: number;
}

export function pageMeta(page: number, perPage: number, total: number): PageMeta {
  const safeTotal = total < 0 ? 0 : total;
  return {
    page,
    per_page: perPage,
    total: safeTotal,
    last_page: Math.max(1, Math.ceil(safeTotal / perPage)),
  };
}

/** Consistent success envelope: `{ data }` or `{ data, meta }`. */
export function ok<TData>(
  data: TData,
  meta?: PageMeta | Record<string, unknown>,
): { data: TData; meta?: PageMeta | Record<string, unknown> } {
  if (meta === undefined) return { data };
  return { data, meta };
}

/** Coerce drizzle `numeric` (string) / number / nullish to a JS number. */
export function num(
  value: string | number | null | undefined,
  fallback = 0,
): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : fallback;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}

export type Rating = 1 | 2 | 3 | 4 | 5;

/** Rating must be an integer 1-5 (mirrors Laravel `between:1,5`). */
export function validateRating(value: unknown): value is Rating {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 5
  );
}

export type DealType = "distress" | "deal_of_day" | "standard";

/** Normalise free-form deal input ("Distress", "deal of day") to the enum. */
export function normalizeDealType(value: unknown): DealType {
  const v = String(value ?? "standard").toLowerCase();
  if (v.includes("distress")) return "distress";
  if (v.includes("deal")) return "deal_of_day";
  return "standard";
}

export interface PromotionWindow {
  days: number;
  featured: boolean;
}

const PROMOTION_WINDOWS: Record<string, PromotionWindow> = {
  bump_5_days: { days: 5, featured: false },
  top_featured_7_days: { days: 7, featured: true },
  top_15_days: { days: 15, featured: false },
  top_featured_20_days: { days: 20, featured: true },
};

/** Promotion tier id -> paid window, or null when the tier is unknown. */
export function promotionWindow(tier: unknown): PromotionWindow | null {
  if (typeof tier !== "string") return null;
  return PROMOTION_WINDOWS[tier] ?? null;
}

/** Expiry date for a promotion tier, or null when the tier is unknown. */
export function promotionExpiry(tier: unknown, from: Date = new Date()): Date | null {
  const window = promotionWindow(tier);
  if (!window) return null;
  return new Date(from.getTime() + window.days * 24 * 60 * 60 * 1000);
}

/**
 * Distress deals require a minimum 20% discount (mirrors Laravel rule).
 * No discount price set => nothing to validate => true.
 */
export function distressDiscountOk(price: unknown, discountPrice: unknown): boolean {
  const d =
    discountPrice === null || discountPrice === undefined || discountPrice === ""
      ? null
      : Number(discountPrice);
  if (d === null || Number.isNaN(d)) return true;
  const p = Number(price);
  if (!Number.isFinite(p) || p <= 0) return false;
  return ((p - d) / p) * 100 >= 20;
}

export function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}

/** Contact fields a provider owner may propose changes for (needs approval). */
export const CONTACT_UPDATE_FIELDS = [
  "phone",
  "whatsapp",
  "email",
  "location_text",
  "bio",
] as const;
export type ContactUpdateField = (typeof CONTACT_UPDATE_FIELDS)[number];

export function findUnknownContactFields(input: Record<string, unknown>): string[] {
  const allowed: readonly string[] = CONTACT_UPDATE_FIELDS;
  return Object.keys(input).filter((key) => !allowed.includes(key));
}

export const BOOKING_STATUS_VALUES = [
  "pending",
  "accepted",
  "in_progress",
  "completed",
  "cancelled",
  "declined",
] as const;
export type BookingStatus = (typeof BOOKING_STATUS_VALUES)[number];

/** Public status transitions exposed by PATCH /bookings/:id/status. */
export const BOOKING_PUBLIC_STATUSES = [
  "accepted",
  "declined",
  "completed",
  "cancelled",
] as const;
export type BookingPublicStatus = (typeof BOOKING_PUBLIC_STATUSES)[number];

export const FINAL_BOOKING_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "cancelled",
  "declined",
]);

export const REVIEW_TARGETS = ["store", "provider", "listing"] as const;
export type ReviewTarget = (typeof REVIEW_TARGETS)[number];

export function isReviewTarget(value: unknown): value is ReviewTarget {
  return (
    typeof value === "string" &&
    (REVIEW_TARGETS as readonly string[]).includes(value)
  );
}
