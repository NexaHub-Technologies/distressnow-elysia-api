/**
 * Listings module.
 *
 * Route order matters: GET /listings/deals is registered BEFORE
 * GET /listings/:id so "deals" is never treated as a UUID.
 *
 * Public identifiers are UUIDs (Laravel route-binding parity); integer PKs
 * stay internal. Soft-deleted rows are hidden everywhere.
 *
 * - GET    /listings                        public feed (filters/sort/page)
 * - GET    /listings/deals                  distress + deal-of-day feed
 * - GET    /listings/:id                    public detail (UUID)
 * - GET    /user/listings                   own listings (auth)
 * - POST   /listings                        create (auth, distress >= 20% off)
 * - PUT    /listings/:id                    owner update (auth)
 * - DELETE /listings/:id                    owner soft-delete (auth)
 * - POST   /listings/:id/images             owner multipart upload (auth)
 * - POST   /listings/:id/promote            owner promotion {tier} (auth)
 * - POST   /listings/:id/click              public analytics
 * - POST   /listings/:id/view               public analytics
 * - POST   /listings/:id/favorite           toggle favorite (auth)
 * - GET    /user/favorites                  favorite listings (auth)
 * - POST   /listings/:id/recently-viewed    track view (auth)
 * - GET    /user/recently-viewed            recent views (auth)
 */
import { Elysia, t } from "elysia";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { db } from "../../db/client";
import {
  categories,
  favoriteListings,
  listingImages,
  listings,
  recentlyViewedListings,
  states,
  stores,
  subcategories,
  sublocations,
} from "../../db/schema";

type Listing = typeof listings.$inferSelect;
import { auth } from "../../plugins/auth";
import { created, fail, ok, paginated } from "../../utils/response";
import { buildMeta, parsePagination } from "../../utils/pagination";
import {
  buildPagination,
  distressDiscountOk,
  isUuid,
  normalizeDealType,
  num,
  promotionWindow,
  slugify,
  type DealType,
} from "../../utils/marketplace";
import {
  findMarketById,
  resolveCategoryIdStrict,
  resolveCategoryScope,
  resolveMarketId,
  resolveStateId,
  resolveSubcategoryId,
  resolveSublocationId,
} from "../../utils/lookups";

// ── Pure filter query builder (unit-tested, no DB) ──────────────────────────

export type ListingSort = "newest" | "price_low" | "price_high" | "popular";

export interface ListingFilters {
  q?: string;
  category?: string;
  subcategory?: string;
  state?: string;
  sublocation?: string;
  market?: string;
  minPrice?: number;
  maxPrice?: number;
  condition?: string;
  dealType?: DealType;
  /** `distress=true` narrows to distress + deal-of-day listings. */
  distressOnly: boolean;
  sort: ListingSort;
  page: number;
  perPage: number;
}

function cleanString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function cleanNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
}

function isSort(value: string): value is ListingSort {
  return value === "newest" || value === "price_low" || value === "price_high" || value === "popular";
}

function isDealType(value: string): value is DealType {
  return value === "distress" || value === "deal_of_day" || value === "standard";
}

/**
 * Normalise raw query input into listing filters. Pure: safe to unit test.
 * Accepts the Laravel-compatible aliases used by the mobile clients
 * (`category_id`, `min_price`, `dealType`, `is_distressed`, ...).
 */
export function normalizeListingFilters(query: Record<string, unknown>): ListingFilters {
  const { page, perPage } = buildPagination(query.page, query.per_page);
  const rawSort = cleanString(query.sort) ?? "newest";
  const rawDeal = cleanString(query.deal_type ?? query.dealType);
  const distressRaw = query.distress ?? query.is_distressed ?? query.isDistressed;
  return {
    q: cleanString(query.q),
    category: cleanString(query.category ?? query.category_id ?? query.category_slug),
    subcategory: cleanString(query.subcategory ?? query.subcategory_id),
    state: cleanString(query.state ?? query.state_id),
    sublocation: cleanString(query.sublocation ?? query.sublocation_id),
    market: cleanString(query.market ?? query.market_id),
    minPrice: cleanNumber(query.min_price ?? query.minPrice),
    maxPrice: cleanNumber(query.max_price ?? query.maxPrice),
    condition: cleanString(query.condition),
    dealType: rawDeal && isDealType(rawDeal) ? rawDeal : undefined,
    distressOnly:
      distressRaw === true || distressRaw === 1 || distressRaw === "true" || distressRaw === "1",
    sort: isSort(rawSort) ? rawSort : "newest",
    page,
    perPage,
  };
}

// ── Serializers ──────────────────────────────────────────────────────────────

interface ListingRelations {
  categories: Map<number, { uuid: string; name: string; slug: string }>;
  subcategories: Map<number, { uuid: string; name: string; slug: string }>;
  states: Map<number, { uuid: string; name: string; slug: string }>;
  sublocations: Map<number, { uuid: string; name: string; slug: string }>;
  stores: Map<number, { uuid: string; name: string; slug: string }>;
  images: Map<number, { id: number; path: string; url: string | null; is_primary: boolean }[]>;
}

export async function loadListingRelations(rows: Listing[]): Promise<ListingRelations> {
  const pick = (ids: (number | null)[]) => [...new Set(ids.filter((v): v is number => v !== null))];
  const categoryIds = pick(rows.map((r) => r.categoryId));
  const subcategoryIds = pick(rows.map((r) => r.subcategoryId));
  const stateIds = pick(rows.map((r) => r.stateId));
  const sublocationIds = pick(rows.map((r) => r.sublocationId));
  const storeIds = pick(rows.map((r) => r.storeId));
  const listingIds = rows.map((r) => r.id);

  const [catRows, subRows, stateRows, sublocRows, storeRows, imageRows] = await Promise.all([
    db.select({ id: categories.id, uuid: categories.uuid, name: categories.name, slug: categories.slug }).from(categories),
    db.select({ id: subcategories.id, uuid: subcategories.uuid, name: subcategories.name, slug: subcategories.slug }).from(subcategories),
    db.select({ id: states.id, uuid: states.uuid, name: states.name, slug: states.slug }).from(states),
    db.select({ id: sublocations.id, uuid: sublocations.uuid, name: sublocations.name, slug: sublocations.slug }).from(sublocations),
    db.select({ id: stores.id, uuid: stores.uuid, name: stores.name, slug: stores.slug }).from(stores),
    listingIds.length > 0
      ? db
          .select()
          .from(listingImages)
          .where(
            and(inArray(listingImages.listingId, listingIds), isNull(listingImages.deletedAt)),
          )
          .orderBy(asc(listingImages.createdAt))
      : Promise.resolve([] as (typeof listingImages.$inferSelect)[]),
  ]);

  const wanted = (ids: number[]) => new Set(ids);
  const keep = <T extends { id: number }>(all: T[], ids: number[]): Map<number, T> =>
    new Map(all.filter((r) => wanted(ids).has(r.id)).map((r) => [r.id, r]));

  const imagesByListing = new Map<
    number,
    { id: number; path: string; url: string | null; is_primary: boolean }[]
  >();
  for (const image of imageRows) {
    const list = imagesByListing.get(image.listingId) ?? [];
    list.push({ id: image.id, path: image.path, url: image.url, is_primary: image.isPrimary });
    imagesByListing.set(image.listingId, list);
  }

  return {
    categories: keep(catRows, categoryIds),
    subcategories: keep(subRows, subcategoryIds),
    states: keep(stateRows, stateIds),
    sublocations: keep(sublocRows, sublocationIds),
    stores: keep(storeRows, storeIds),
    images: imagesByListing,
  };
}

export function serializeListing(listing: Listing, rel: ListingRelations) {
  return {
    id: listing.uuid,
    user_id: listing.userId,
    store_id: listing.storeId,
    title: listing.title,
    slug: listing.slug,
    description: listing.description,
    price: num(listing.price),
    discount_price: listing.discountPrice === null ? null : num(listing.discountPrice),
    discount_percentage: listing.discountPercentage,
    is_discounted: listing.isDiscounted,
    condition: listing.condition,
    listing_scope: listing.listingScope,
    deal_type: listing.dealType,
    status: listing.status,
    approved: listing.approved,
    promoted: listing.promoted,
    promotion_type: listing.promotionType,
    promotion_expiry: listing.promotionExpiry,
    featured: listing.featured,
    views_count: listing.viewsCount,
    clicks_count: listing.clicksCount,
    favorites_count: listing.favoritesCount,
    latitude: listing.latitude === null ? null : num(listing.latitude),
    longitude: listing.longitude === null ? null : num(listing.longitude),
    category_specific_fields: (listing.categorySpecificFields as Record<string, unknown> | null) ?? null,
    category: rel.categories.get(listing.categoryId) ?? null,
    subcategory: listing.subcategoryId
      ? (rel.subcategories.get(listing.subcategoryId) ?? null)
      : null,
    state: rel.states.get(listing.stateId) ?? null,
    sublocation: listing.sublocationId
      ? (rel.sublocations.get(listing.sublocationId) ?? null)
      : null,
    store: listing.storeId ? (rel.stores.get(listing.storeId) ?? null) : null,
    images: rel.images.get(listing.id) ?? [],
    created_at: listing.createdAt,
    updated_at: listing.updatedAt,
  };
}

// ── Shared query assembly ────────────────────────────────────────────────────

const ACTIVE = and(eq(listings.status, "active"), isNull(listings.deletedAt));

/**
 * Apply normalised filters to a conditions array. Returns `null` when a
 * reference (category/state/market/...) is unresolvable => empty result.
 */
async function filterConditions(filters: ListingFilters) {
  const conditions = [];

  if (filters.q) {
    const needle = `%${filters.q}%`;
    conditions.push(or(ilike(listings.title, needle), ilike(listings.description, needle)));
  }

  if (filters.category) {
    const scope = await resolveCategoryScope(filters.category);
    if (scope === null) return null;
    if (scope?.categoryId) conditions.push(eq(listings.categoryId, scope.categoryId));
    if (scope?.subcategoryId) conditions.push(eq(listings.subcategoryId, scope.subcategoryId));
  }

  if (filters.subcategory) {
    const subId = await resolveSubcategoryId(filters.subcategory);
    if (subId === null) return null;
    if (subId !== undefined) conditions.push(eq(listings.subcategoryId, subId));
  }

  if (filters.state) {
    const stateId = await resolveStateId(filters.state);
    if (stateId === null) return null;
    if (stateId !== undefined) conditions.push(eq(listings.stateId, stateId));
  }

  if (filters.sublocation) {
    const subId = await resolveSublocationId(filters.sublocation);
    if (subId === null) return null;
    if (subId !== undefined) conditions.push(eq(listings.sublocationId, subId));
  }

  if (filters.market) {
    // Listings carry state/sublocation (no market FK): map the market.
    const marketId = await resolveMarketId(filters.market);
    if (marketId === null) return null;
    if (marketId !== undefined) {
      const market = await findMarketById(marketId);
      if (!market) return null;
      if (market.sublocationId) conditions.push(eq(listings.sublocationId, market.sublocationId));
      else conditions.push(eq(listings.stateId, market.stateId));
    }
  }

  if (filters.minPrice !== undefined) conditions.push(gte(listings.price, String(filters.minPrice)));
  if (filters.maxPrice !== undefined) conditions.push(lte(listings.price, String(filters.maxPrice)));
  if (filters.condition) conditions.push(eq(listings.condition, filters.condition));

  if (filters.dealType) {
    conditions.push(eq(listings.dealType, filters.dealType));
  } else if (filters.distressOnly) {
    conditions.push(inArray(listings.dealType, ["distress", "deal_of_day"]));
  }

  return conditions;
}

function orderForSort(sort: ListingSort) {
  switch (sort) {
    case "price_low":
      return asc(listings.price);
    case "price_high":
      return desc(listings.price);
    case "popular":
      return desc(listings.viewsCount);
    case "newest":
    default:
      return desc(listings.createdAt);
  }
}

async function listingByUuid(uuid: string) {
  const rows = await db
    .select()
    .from(listings)
    .where(and(eq(listings.uuid, uuid), isNull(listings.deletedAt)))
    .limit(1);
  return rows[0] ?? null;
}

async function uniqueListingSlug(title: string): Promise<string> {
  const base = slugify(title) || "listing";
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const candidate =
      attempt === 0 ? `${base}-${Date.now().toString(36)}` : `${base}-${Date.now().toString(36)}-${attempt}`;
    const rows = await db
      .select({ id: listings.id })
      .from(listings)
      .where(eq(listings.slug, candidate))
      .limit(1);
    if (!rows[0]) return candidate;
  }
  return `${base}-${Date.now().toString(36)}-x`;
}

function discountMeta(price: number, discountPrice: number | null) {
  if (discountPrice === null || !(discountPrice < price) || !(price > 0)) {
    return { discountPercentage: 0, isDiscounted: false };
  }
  return {
    discountPercentage: Math.round(((price - discountPrice) / price) * 100),
    isDiscounted: true,
  };
}

async function resolveStoreUuid(ref: string | null | undefined, ownerId: number) {
  if (!ref) return null;
  if (!isUuid(ref)) return -1;
  const rows = await db.select().from(stores).where(eq(stores.uuid, ref)).limit(1);
  const store = rows[0];
  if (!store || store.userId !== ownerId) return -1;
  return store.id;
}

// ── Multipart image helpers ──────────────────────────────────────────────────

function extractFiles(value: unknown): File[] {
  if (!value) return [];
  const items = Array.isArray(value) ? value : [value];
  return items.filter(
    (item): item is File =>
      typeof item === "object" &&
      item !== null &&
      typeof (item as File).arrayBuffer === "function" &&
      typeof (item as File).name === "string",
  );
}

function safeFileName(name: string): string {
  const parts = name.split(".");
  const ext = parts.length > 1 ? parts.pop() ?? "" : "";
  const stem = slugify(parts.join("-")) || "image";
  return ext ? `${stem}.${ext.toLowerCase().replace(/[^a-z0-9]/g, "")}` : stem;
}

// ── Schemas ──────────────────────────────────────────────────────────────────

const uuidParams = t.Object({ id: t.String({ format: "uuid" }) });

const listingQuerySchema = t.Object({
  q: t.Optional(t.String()),
  category: t.Optional(t.String()),
  category_id: t.Optional(t.String()),
  category_slug: t.Optional(t.String()),
  subcategory: t.Optional(t.String()),
  subcategory_id: t.Optional(t.String()),
  state: t.Optional(t.String()),
  state_id: t.Optional(t.String()),
  sublocation: t.Optional(t.String()),
  sublocation_id: t.Optional(t.String()),
  market: t.Optional(t.String()),
  market_id: t.Optional(t.String()),
  min_price: t.Optional(t.String()),
  max_price: t.Optional(t.String()),
  condition: t.Optional(t.String()),
  deal_type: t.Optional(t.String()),
  dealType: t.Optional(t.String()),
  distress: t.Optional(t.String()),
  sort: t.Optional(t.String()),
  page: t.Optional(t.String()),
  per_page: t.Optional(t.String()),
});

const listingBodySchema = t.Object({
  title: t.String({ minLength: 1, maxLength: 255 }),
  description: t.String({ minLength: 1 }),
  price: t.Number({ minimum: 0 }),
  discount_price: t.Optional(t.Union([t.Number({ minimum: 0 }), t.Null()])),
  category_id: t.Optional(t.String()),
  category: t.Optional(t.String()),
  subcategory_id: t.Optional(t.String()),
  state_id: t.Optional(t.String()),
  state: t.Optional(t.String()),
  sublocation_id: t.Optional(t.String()),
  sublocation: t.Optional(t.String()),
  store_id: t.Optional(t.Union([t.String(), t.Null()])),
  condition: t.String({ minLength: 1 }),
  listing_scope: t.Optional(t.String()),
  deal_type: t.Optional(t.String()),
  dealType: t.Optional(t.String()),
  latitude: t.Optional(t.Union([t.Number(), t.Null()])),
  longitude: t.Optional(t.Union([t.Number(), t.Null()])),
  category_specific_fields: t.Optional(t.Record(t.String(), t.Unknown())),
  promotion_package: t.Optional(t.String()),
  promotion_type: t.Optional(t.String()),
});

// ── Module ───────────────────────────────────────────────────────────────────

export const listingsModule = new Elysia()
  .use(auth)
  .get(
    "/listings",
    async ({ query }) => {
      const filters = normalizeListingFilters(query as Record<string, unknown>);
      const extra = await filterConditions(filters);
      if (extra === null) return paginated([], buildMeta(filters.page, filters.perPage, 0));
      const where = and(ACTIVE, ...extra);
      const [rows, totalRows] = await Promise.all([
        db
          .select()
          .from(listings)
          .where(where)
          .orderBy(orderForSort(filters.sort))
          .limit(filters.perPage)
          .offset((filters.page - 1) * filters.perPage),
        db.select({ total: count() }).from(listings).where(where),
      ]);
      const rel = await loadListingRelations(rows);
      return paginated(
        rows.map((listing) => serializeListing(listing, rel)),
        buildMeta(filters.page, filters.perPage, totalRows[0]?.total ?? 0),
      );
    },
    { query: listingQuerySchema },
  )
  // Registered BEFORE /listings/:id so "deals" is not parsed as a UUID.
  .get(
    "/listings/deals",
    async ({ query }) => {
      const { page, perPage, offset } = parsePagination(query);
      const rawDeal = query.deal_type?.trim();
      const conditions = [
        eq(listings.status, "active"),
        isNull(listings.deletedAt),
        inArray(listings.dealType, ["distress", "deal_of_day"]),
      ];
      if (rawDeal === "distress" || rawDeal === "deal_of_day") {
        conditions.push(eq(listings.dealType, rawDeal));
      }
      const where = and(...conditions);
      const [rows, totalRows] = await Promise.all([
        db.select().from(listings).where(where).orderBy(desc(listings.createdAt)).limit(perPage).offset(offset),
        db.select({ total: count() }).from(listings).where(where),
      ]);
      const rel = await loadListingRelations(rows);
      return paginated(
        rows.map((listing) => serializeListing(listing, rel)),
        buildMeta(page, perPage, totalRows[0]?.total ?? 0),
      );
    },
    {
      query: t.Object({
        deal_type: t.Optional(t.String()),
        page: t.Optional(t.String()),
        per_page: t.Optional(t.String()),
      }),
    },
  )
  .get(
    "/listings/:id",
    async ({ params, set }) => {
      const listing = await listingByUuid(params.id);
      if (!listing) {
        set.status = 404;
        return fail("Listing not found.");
      }
      const rel = await loadListingRelations([listing]);
      return ok(serializeListing(listing, rel));
    },
    { params: uuidParams },
  )
  .get(
    "/user/listings",
    async ({ currentUser, query, set }) => {
      if (!currentUser) {
        set.status = 401;
        return fail("Unauthenticated.");
      }
      const { page, perPage, offset } = parsePagination(query);
      const where = and(eq(listings.userId, currentUser.id), isNull(listings.deletedAt));
      const [rows, totalRows] = await Promise.all([
        db.select().from(listings).where(where).orderBy(desc(listings.createdAt)).limit(perPage).offset(offset),
        db.select({ total: count() }).from(listings).where(where),
      ]);
      const rel = await loadListingRelations(rows);
      return paginated(
        rows.map((listing) => serializeListing(listing, rel)),
        buildMeta(page, perPage, totalRows[0]?.total ?? 0),
      );
    },
    {
      query: t.Object({
        page: t.Optional(t.String()),
        per_page: t.Optional(t.String()),
      }),
    },
  )
  .post(
    "/listings",
    async ({ body, currentUser, set }) => {
      if (!currentUser) {
        set.status = 401;
        return fail("Unauthenticated.");
      }
      const categoryId = await resolveCategoryIdStrict(body.category_id ?? body.category);
      if (!categoryId) {
        set.status = 422;
        return fail("A valid category is required.");
      }
      const stateId = await resolveStateId(body.state_id ?? body.state);
      if (!stateId) {
        set.status = 422;
        return fail("A valid state is required.");
      }
      const subcategoryId = await resolveSubcategoryId(body.subcategory_id);
      if (body.subcategory_id && subcategoryId === null) {
        set.status = 422;
        return fail("Unknown subcategory.");
      }
      const sublocationId = await resolveSublocationId(body.sublocation_id ?? body.sublocation);
      if ((body.sublocation_id ?? body.sublocation) && sublocationId == null) {
        set.status = 422;
        return fail("Unknown sublocation.");
      }

      const storeId = await resolveStoreUuid(body.store_id ?? null, currentUser.id);
      if ((body.store_id ?? null) && (storeId === null || storeId === -1)) {
        set.status = 422;
        return fail("Unknown store.");
      }

      const dealType = normalizeDealType(body.deal_type ?? body.dealType ?? "standard");
      if (dealType === "distress" && !distressDiscountOk(body.price, body.discount_price ?? null)) {
        set.status = 422;
        return fail("Distress deals require a minimum of 20% discount.");
      }

      const scope = body.listing_scope === "store" ? "store" : "personal";
      if (scope === "store" && !storeId) {
        set.status = 422;
        return fail("Store listings require a store_id you own.");
      }

      const discountPrice = body.discount_price ?? null;
      const { discountPercentage, isDiscounted } = discountMeta(body.price, discountPrice);

      const values: typeof listings.$inferInsert = {
        userId: currentUser.id,
        storeId: storeId || null,
        categoryId,
        subcategoryId: subcategoryId ?? null,
        stateId,
        sublocationId: sublocationId ?? null,
        categorySpecificFields: (body.category_specific_fields ?? null) as Record<string, unknown> | null,
        title: body.title,
        slug: await uniqueListingSlug(body.title),
        description: body.description,
        price: String(body.price),
        discountPrice: discountPrice === null ? null : String(discountPrice),
        discountPercentage,
        isDiscounted,
        condition: body.condition,
        listingScope: scope,
        dealType,
        status: "pending",
        approved: false,
        latitude: body.latitude === undefined || body.latitude === null ? null : String(body.latitude),
        longitude: body.longitude === undefined || body.longitude === null ? null : String(body.longitude),
      };

      const promoTier = body.promotion_package ?? body.promotion_type;
      if (promoTier) {
        const window = promotionWindow(promoTier);
        if (window) {
          values.promoted = true;
          values.promotionType = promoTier;
          values.promotionExpiry = new Date(Date.now() + window.days * 24 * 60 * 60 * 1000);
          if (window.featured) values.featured = true;
        }
      }

      const inserted = await db.insert(listings).values(values).returning();
      const listing = inserted[0];
      if (!listing) {
        set.status = 500;
        return fail("Could not create listing.");
      }
      if (storeId) {
        await db
          .update(stores)
          .set({ listingsCount: sql`${stores.listingsCount} + 1` })
          .where(eq(stores.id, storeId));
      }
      const rel = await loadListingRelations([listing]);
      set.status = 201;
      return created(serializeListing(listing, rel), "Listing created.");
    },
    { body: listingBodySchema },
  )
  .put(
    "/listings/:id",
    async ({ params, body, currentUser, set }) => {
      if (!currentUser) {
        set.status = 401;
        return fail("Unauthenticated.");
      }
      const listing = await listingByUuid(params.id);
      if (!listing) {
        set.status = 404;
        return fail("Listing not found.");
      }
      if (listing.userId !== currentUser.id) {
        set.status = 403;
        return fail("Unauthorized.");
      }

      const patch: Partial<typeof listings.$inferInsert> = {};
      if (body.title !== undefined) {
        patch.title = body.title;
        patch.slug = await uniqueListingSlug(body.title);
      }
      if (body.description !== undefined) patch.description = body.description;

      const nextPrice = body.price ?? num(listing.price);
      const nextDiscount =
        body.discount_price !== undefined
          ? body.discount_price
          : listing.discountPrice === null
            ? null
            : num(listing.discountPrice);
      if (body.price !== undefined) patch.price = String(body.price);
      if (body.discount_price !== undefined) {
        patch.discountPrice = body.discount_price === null ? null : String(body.discount_price);
      }
      const { discountPercentage, isDiscounted } = discountMeta(nextPrice, nextDiscount);
      patch.discountPercentage = discountPercentage;
      patch.isDiscounted = isDiscounted;

      if (body.category_id !== undefined || body.category !== undefined) {
        const categoryId = await resolveCategoryIdStrict(body.category_id ?? body.category);
        if (!categoryId) {
          set.status = 422;
          return fail("Unknown category.");
        }
        patch.categoryId = categoryId;
      }
      if (body.subcategory_id !== undefined) {
        const nextSub = await resolveSubcategoryId(body.subcategory_id ?? undefined);
        if (body.subcategory_id && nextSub == null) {
          set.status = 422;
          return fail("Unknown subcategory.");
        }
        patch.subcategoryId = nextSub ?? null;
      }
      const stateRef = body.state_id ?? body.state;
      if (stateRef !== undefined) {
        const nextState = await resolveStateId(stateRef || undefined);
        if (!nextState) {
          set.status = 422;
          return fail("Unknown state.");
        }
        patch.stateId = nextState;
      }
      const subRef = body.sublocation_id ?? body.sublocation;
      if (subRef !== undefined) {
        const nextSub = await resolveSublocationId(subRef || undefined);
        if (subRef && nextSub == null) {
          set.status = 422;
          return fail("Unknown sublocation.");
        }
        patch.sublocationId = nextSub ?? null;
      }
      if (body.condition !== undefined) patch.condition = body.condition;
      if (body.latitude !== undefined) {
        patch.latitude = body.latitude === null ? null : String(body.latitude);
      }
      if (body.longitude !== undefined) {
        patch.longitude = body.longitude === null ? null : String(body.longitude);
      }
      if (body.category_specific_fields !== undefined) {
        patch.categorySpecificFields = body.category_specific_fields as Record<string, unknown>;
      }

      const nextDeal = normalizeDealType(
        body.deal_type ?? body.dealType ?? listing.dealType,
      );
      patch.dealType = nextDeal;
      if (nextDeal === "distress" && !listing.approved && !distressDiscountOk(nextPrice, nextDiscount)) {
        set.status = 422;
        return fail("Distress deals require a minimum of 20% discount.");
      }

      const promoTier = body.promotion_package ?? body.promotion_type;
      if (promoTier) {
        const window = promotionWindow(promoTier);
        if (window) {
          patch.promoted = true;
          patch.promotionType = promoTier;
          patch.promotionExpiry = new Date(Date.now() + window.days * 24 * 60 * 60 * 1000);
          if (window.featured) patch.featured = true;
        }
      }

      const updated = await db
        .update(listings)
        .set(patch)
        .where(eq(listings.id, listing.id))
        .returning();
      const next = updated[0] ?? listing;
      const rel = await loadListingRelations([next]);
      return ok(serializeListing(next, rel));
    },
    {
      params: uuidParams,
      body: t.Object({
        title: t.Optional(t.String({ minLength: 1, maxLength: 255 })),
        description: t.Optional(t.String({ minLength: 1 })),
        price: t.Optional(t.Number({ minimum: 0 })),
        discount_price: t.Optional(t.Union([t.Number({ minimum: 0 }), t.Null()])),
        category_id: t.Optional(t.String()),
        category: t.Optional(t.String()),
        subcategory_id: t.Optional(t.Union([t.String(), t.Null()])),
        state_id: t.Optional(t.String()),
        state: t.Optional(t.String()),
        sublocation_id: t.Optional(t.Union([t.String(), t.Null()])),
        sublocation: t.Optional(t.Union([t.String(), t.Null()])),
        condition: t.Optional(t.String()),
        deal_type: t.Optional(t.String()),
        dealType: t.Optional(t.String()),
        latitude: t.Optional(t.Union([t.Number(), t.Null()])),
        longitude: t.Optional(t.Union([t.Number(), t.Null()])),
        category_specific_fields: t.Optional(t.Record(t.String(), t.Unknown())),
        promotion_package: t.Optional(t.String()),
        promotion_type: t.Optional(t.String()),
      }),
    },
  )
  .delete(
    "/listings/:id",
    async ({ params, currentUser, set }) => {
      if (!currentUser) {
        set.status = 401;
        return fail("Unauthenticated.");
      }
      const listing = await listingByUuid(params.id);
      if (!listing) {
        set.status = 404;
        return fail("Listing not found.");
      }
      if (listing.userId !== currentUser.id) {
        set.status = 403;
        return fail("Unauthorized.");
      }
      await db
        .update(listings)
        .set({ deletedAt: new Date() })
        .where(eq(listings.id, listing.id));
      if (listing.storeId) {
        await db
          .update(stores)
          .set({ listingsCount: sql`GREATEST(${stores.listingsCount} - 1, 0)` })
          .where(eq(stores.id, listing.storeId));
      }
      return ok(null, "Listing deleted successfully.");
    },
    { params: uuidParams },
  )
  .post(
    "/listings/:id/images",
    async ({ params, body, currentUser, set }) => {
      if (!currentUser) {
        set.status = 401;
        return fail("Unauthenticated.");
      }
      const listing = await listingByUuid(params.id);
      if (!listing) {
        set.status = 404;
        return fail("Listing not found.");
      }
      if (listing.userId !== currentUser.id) {
        set.status = 403;
        return fail("Unauthorized.");
      }
      const files = extractFiles((body as Record<string, unknown>).images);
      if (files.length === 0) {
        set.status = 422;
        return fail("At least one image is required.");
      }
      if (files.length > 5) {
        set.status = 422;
        return fail("A maximum of 5 images per upload is allowed.");
      }
      const existingCount = await db
        .select({ total: count() })
        .from(listingImages)
        .where(
          and(eq(listingImages.listingId, listing.id), isNull(listingImages.deletedAt)),
        );
      const hasImages = (existingCount[0]?.total ?? 0) > 0;
      const createdImages: { id: number; path: string; url: string | null; is_primary: boolean }[] = [];
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        if (!file) continue;
        const path = `listings/${listing.uuid}/${Date.now()}-${index}-${safeFileName(file.name)}`;
        try {
          await Bun.write(`uploads/${path}`, file);
        } catch {
          // Best-effort local persistence; the DB row stays the source of truth.
        }
        const inserted = await db
          .insert(listingImages)
          .values({ listingId: listing.id, path, isPrimary: !hasImages && index === 0 })
          .returning();
        const row = inserted[0];
        if (row) {
          createdImages.push({ id: row.id, path: row.path, url: row.url, is_primary: row.isPrimary });
        }
      }
      set.status = 201;
      return created(createdImages, "Images uploaded.");
    },
    {
      params: uuidParams,
      body: t.Object({ images: t.Optional(t.Any()) }),
    },
  )
  .post(
    "/listings/:id/promote",
    async ({ params, body, currentUser, set }) => {
      if (!currentUser) {
        set.status = 401;
        return fail("Unauthenticated.");
      }
      const listing = await listingByUuid(params.id);
      if (!listing) {
        set.status = 404;
        return fail("Listing not found.");
      }
      if (listing.userId !== currentUser.id) {
        set.status = 403;
        return fail("Unauthorized.");
      }
      const tier = (body.tier ?? body.promotion_package) as string | undefined;
      const window = promotionWindow(tier);
      if (!window) {
        set.status = 422;
        return fail(
          "Unknown promotion tier. Use bump_5_days, top_featured_7_days, top_15_days or top_featured_20_days.",
        );
      }
      const updated = await db
        .update(listings)
        .set({
          promoted: true,
          promotionType: tier,
          promotionExpiry: new Date(Date.now() + window.days * 24 * 60 * 60 * 1000),
          ...(window.featured ? { featured: true } : {}),
        })
        .where(eq(listings.id, listing.id))
        .returning();
      const next = updated[0] ?? listing;
      const rel = await loadListingRelations([next]);
      return ok(serializeListing(next, rel), "Listing promoted.");
    },
    {
      params: uuidParams,
      body: t.Object({
        tier: t.Optional(t.String()),
        promotion_package: t.Optional(t.String()),
      }),
    },
  )
  .post(
    "/listings/:id/click",
    async ({ params, set }) => {
      const listing = await listingByUuid(params.id);
      if (!listing) {
        set.status = 404;
        return fail("Listing not found.");
      }
      const updated = await db
        .update(listings)
        .set({ clicksCount: sql`${listings.clicksCount} + 1` })
        .where(eq(listings.id, listing.id))
        .returning({ clicksCount: listings.clicksCount });
      return ok(
        { clicks_count: updated[0]?.clicksCount ?? listing.clicksCount + 1 },
        "Click recorded.",
      );
    },
    { params: uuidParams },
  )
  .post(
    "/listings/:id/view",
    async ({ params, set }) => {
      const listing = await listingByUuid(params.id);
      if (!listing) {
        set.status = 404;
        return fail("Listing not found.");
      }
      const updated = await db
        .update(listings)
        .set({ viewsCount: sql`${listings.viewsCount} + 1` })
        .where(eq(listings.id, listing.id))
        .returning({ viewsCount: listings.viewsCount });
      return ok(
        { views_count: updated[0]?.viewsCount ?? listing.viewsCount + 1 },
        "View recorded.",
      );
    },
    { params: uuidParams },
  )
  .post(
    "/listings/:id/favorite",
    async ({ params, currentUser, set }) => {
      if (!currentUser) {
        set.status = 401;
        return fail("Unauthenticated.");
      }
      const listing = await listingByUuid(params.id);
      if (!listing) {
        set.status = 404;
        return fail("Listing not found.");
      }
      const existing = await db
        .select({ id: favoriteListings.id })
        .from(favoriteListings)
        .where(
          and(
            eq(favoriteListings.userId, currentUser.id),
            eq(favoriteListings.listingId, listing.id),
            isNull(favoriteListings.deletedAt),
          ),
        )
        .limit(1);
      const favorite = existing[0];
      if (favorite) {
        await db.delete(favoriteListings).where(eq(favoriteListings.id, favorite.id));
        const updated = await db
          .update(listings)
          .set({ favoritesCount: sql`GREATEST(${listings.favoritesCount} - 1, 0)` })
          .where(eq(listings.id, listing.id))
          .returning({ favoritesCount: listings.favoritesCount });
        return ok(
          {
            is_favorited: false,
            favorites_count: updated[0]?.favoritesCount ?? 0,
          },
          "Listing removed from favorites.",
        );
      }
      await db.insert(favoriteListings).values({ userId: currentUser.id, listingId: listing.id });
      const updated = await db
        .update(listings)
        .set({ favoritesCount: sql`${listings.favoritesCount} + 1` })
        .where(eq(listings.id, listing.id))
        .returning({ favoritesCount: listings.favoritesCount });
      return ok(
        {
          is_favorited: true,
          favorites_count: updated[0]?.favoritesCount ?? listing.favoritesCount + 1,
        },
        "Listing added to favorites.",
      );
    },
    { params: uuidParams },
  )
  .get(
    "/user/favorites",
    async ({ currentUser, query, set }) => {
      if (!currentUser) {
        set.status = 401;
        return fail("Unauthenticated.");
      }
      const { page, perPage, offset } = parsePagination(query);
      const where = and(
        eq(favoriteListings.userId, currentUser.id),
        isNull(favoriteListings.deletedAt),
      );
      const [favorites, totalRows] = await Promise.all([
        db
          .select({ listingId: favoriteListings.listingId })
          .from(favoriteListings)
          .where(where)
          .orderBy(desc(favoriteListings.createdAt))
          .limit(perPage)
          .offset(offset),
        db.select({ total: count() }).from(favoriteListings).where(where),
      ]);
      const ids = favorites.map((f) => f.listingId);
      const rows =
        ids.length > 0
          ? await db
              .select()
              .from(listings)
              .where(
                and(
                  inArray(listings.id, ids),
                  eq(listings.status, "active"),
                  isNull(listings.deletedAt),
                ),
              )
          : [];
      const rel = await loadListingRelations(rows);
      return paginated(
        rows.map((listing) => serializeListing(listing, rel)),
        buildMeta(page, perPage, totalRows[0]?.total ?? 0),
      );
    },
    {
      query: t.Object({
        page: t.Optional(t.String()),
        per_page: t.Optional(t.String()),
      }),
    },
  )
  .post(
    "/listings/:id/recently-viewed",
    async ({ params, currentUser, set }) => {
      if (!currentUser) {
        set.status = 401;
        return fail("Unauthenticated.");
      }
      const listing = await listingByUuid(params.id);
      if (!listing) {
        set.status = 404;
        return fail("Listing not found.");
      }
      const existing = await db
        .select({ id: recentlyViewedListings.id })
        .from(recentlyViewedListings)
        .where(
          and(
            eq(recentlyViewedListings.userId, currentUser.id),
            eq(recentlyViewedListings.listingId, listing.id),
          ),
        )
        .limit(1);
      const hit = existing[0];
      if (hit) {
        await db
          .update(recentlyViewedListings)
          .set({ viewedAt: new Date(), deletedAt: null })
          .where(eq(recentlyViewedListings.id, hit.id));
      } else {
        await db
          .insert(recentlyViewedListings)
          .values({ userId: currentUser.id, listingId: listing.id, viewedAt: new Date() });
      }
      // Keep only the 20 most recent rows per user.
      const all = await db
        .select({ id: recentlyViewedListings.id })
        .from(recentlyViewedListings)
        .where(
          and(
            eq(recentlyViewedListings.userId, currentUser.id),
            isNull(recentlyViewedListings.deletedAt),
          ),
        )
        .orderBy(desc(recentlyViewedListings.viewedAt));
      const excess = all.slice(20).map((r) => r.id);
      if (excess.length > 0) {
        await db.delete(recentlyViewedListings).where(inArray(recentlyViewedListings.id, excess));
      }
      return ok(null, "Listing added to recently viewed.");
    },
    { params: uuidParams },
  )
  .get("/user/recently-viewed", async ({ currentUser, set }) => {
    if (!currentUser) {
      set.status = 401;
      return fail("Unauthenticated.");
    }
    const recent = await db
      .select({ listingId: recentlyViewedListings.listingId })
      .from(recentlyViewedListings)
      .where(
        and(
          eq(recentlyViewedListings.userId, currentUser.id),
          isNull(recentlyViewedListings.deletedAt),
        ),
      )
      .orderBy(desc(recentlyViewedListings.viewedAt))
      .limit(20);
    const ids = recent.map((r) => r.listingId);
    if (ids.length === 0) return ok([]);
    const rows = await db
      .select()
      .from(listings)
      .where(
        and(inArray(listings.id, ids), eq(listings.status, "active"), isNull(listings.deletedAt)),
      );
    const order = new Map(ids.map((id, index) => [id, index]));
    rows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    const rel = await loadListingRelations(rows);
    return ok(rows.map((listing) => serializeListing(listing, rel)));
  });

export default listingsModule;
