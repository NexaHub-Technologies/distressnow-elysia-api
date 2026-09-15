/**
 * Unified search module.
 *
 * - GET /search?q=...&type=all|listings|stores|providers plus shared
 *   filters (state, category, min/max price, condition, sort, page).
 *
 * Response envelope:
 * `{ success, message, data: { listings, stores, providers }, errors,
 *   meta: { q, type, page, per_page, counts } }`.
 * Sections not requested come back as `[]`.
 */
import { Elysia, t } from "elysia";
import { and, count, desc, eq, ilike, or, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { listings, serviceProviders, stores } from "../../db/schema";
import {
  loadListingRelations,
  normalizeListingFilters,
  serializeListing,
} from "../listings/index";
import { ok } from "../../utils/response";
import { num } from "../../utils/marketplace";
import { resolveCategoryScope, resolveStateId } from "../../utils/lookups";

type SearchType = "all" | "listings" | "stores" | "providers";

function searchType(value: string | undefined): SearchType {
  if (value === "listings" || value === "stores" || value === "providers") return value;
  return "all";
}

export const searchModule = new Elysia().get(
  "/search",
  async ({ query }) => {
    const type = searchType(query.type);
    const q = query.q?.trim() ?? "";
    const needle = q ? `%${q}%` : null;

    // Reuse the listings filter builder so /search and /listings agree.
    const listingFilters = normalizeListingFilters({
      ...query,
      q: q || undefined,
    });
    const { page, perPage } = { page: listingFilters.page, perPage: listingFilters.perPage };

    const stateId = await resolveStateId(query.state);

    const counts = { listings: 0, stores: 0, providers: 0 };

    // ── Listings ──────────────────────────────────────────────────────
    let listingsData: unknown[] = [];
    if ((type === "all" || type === "listings") && stateId !== null) {
      const conditions = [
        eq(listings.status, "active"),
        ...(stateId !== undefined ? [eq(listings.stateId, stateId)] : []),
        ...(needle
          ? [or(ilike(listings.title, needle), ilike(listings.description, needle))]
          : []),
        ...(listingFilters.minPrice !== undefined
          ? [sql`${listings.price} >= ${String(listingFilters.minPrice)}`]
          : []),
        ...(listingFilters.maxPrice !== undefined
          ? [sql`${listings.price} <= ${String(listingFilters.maxPrice)}`]
          : []),
        ...(listingFilters.condition ? [eq(listings.condition, listingFilters.condition)] : []),
      ];
      // Category may name a category or subcategory; resolve via lookup.
      if (query.category) {
        const scope = await resolveCategoryScope(query.category);
        if (scope === null) {
          counts.listings = 0;
        } else {
          if (scope?.categoryId) conditions.push(eq(listings.categoryId, scope.categoryId));
          if (scope?.subcategoryId) conditions.push(eq(listings.subcategoryId, scope.subcategoryId));
        }
        if (scope !== null) {
          const where = and(...conditions);
          const [rows, totalRows] = await Promise.all([
            db
              .select()
              .from(listings)
              .where(where)
              .orderBy(desc(listings.createdAt))
              .limit(perPage)
              .offset((page - 1) * perPage),
            db.select({ total: count() }).from(listings).where(where),
          ]);
          const rel = await loadListingRelations(rows);
          listingsData = rows.map((listing) => serializeListing(listing, rel));
          counts.listings = totalRows[0]?.total ?? 0;
        }
      } else {
        const where = and(...conditions);
        const [rows, totalRows] = await Promise.all([
          db
            .select()
            .from(listings)
            .where(where)
            .orderBy(desc(listings.createdAt))
            .limit(perPage)
            .offset((page - 1) * perPage),
          db.select({ total: count() }).from(listings).where(where),
        ]);
        const rel = await loadListingRelations(rows);
        listingsData = rows.map((listing) => serializeListing(listing, rel));
        counts.listings = totalRows[0]?.total ?? 0;
      }
    }

    // ── Stores ────────────────────────────────────────────────────────
    let storesData: unknown[] = [];
    if ((type === "all" || type === "stores") && stateId !== null) {
      const conditions = [
        eq(stores.status, "active"),
        eq(stores.isVerified, true),
        ...(stateId !== undefined ? [eq(stores.stateId, stateId)] : []),
        ...(needle
          ? [or(ilike(stores.name, needle), ilike(stores.description, needle))]
          : []),
        ...(query.category
          ? [sql`${stores.categories} @> ${JSON.stringify([query.category])}::jsonb`]
          : []),
      ];
      const where = and(...conditions);
      const [rows, totalRows] = await Promise.all([
        db
          .select()
          .from(stores)
          .where(where)
          .orderBy(desc(stores.lastActiveAt))
          .limit(perPage)
          .offset((page - 1) * perPage),
        db.select({ total: count() }).from(stores).where(where),
      ]);
      storesData = rows.map((store) => ({
        id: store.uuid,
        name: store.name,
        slug: store.slug,
        description: store.description,
        logo_path: store.logoPath,
        rating: num(store.rating),
        followers_count: store.followersCount,
      }));
      counts.stores = totalRows[0]?.total ?? 0;
    }

    // ── Providers ─────────────────────────────────────────────────────
    let providersData: unknown[] = [];
    if ((type === "all" || type === "providers") && stateId !== null) {
      const conditions = [
        eq(serviceProviders.isVerified, true),
        ...(stateId !== undefined ? [eq(serviceProviders.stateId, stateId)] : []),
        ...(needle
          ? [
              or(
                ilike(serviceProviders.name, needle),
                ilike(serviceProviders.bio, needle),
              ),
            ]
          : []),
        ...(query.category
          ? [
              sql`${serviceProviders.serviceCategories} @> ${JSON.stringify([query.category])}::jsonb`,
            ]
          : []),
      ];
      const where = and(...conditions);
      const [rows, totalRows] = await Promise.all([
        db
          .select()
          .from(serviceProviders)
          .where(where)
          .orderBy(desc(serviceProviders.rating))
          .limit(perPage)
          .offset((page - 1) * perPage),
        db.select({ total: count() }).from(serviceProviders).where(where),
      ]);
      providersData = rows.map((provider) => ({
        id: provider.uuid,
        name: provider.name,
        slug: provider.slug,
        bio: provider.bio,
        service_categories: (provider.serviceCategories as string[] | null) ?? [],
        rating: num(provider.rating),
        completed_jobs: provider.completedJobs,
      }));
      counts.providers = totalRows[0]?.total ?? 0;
    }

    const envelope = ok(
      { listings: listingsData, stores: storesData, providers: providersData },
      "Search results.",
    );
    return {
      ...envelope,
      meta: { q, type, page, per_page: perPage, counts },
    };
  },
  {
    query: t.Object({
      q: t.Optional(t.String()),
      type: t.Optional(t.String()),
      state: t.Optional(t.String()),
      category: t.Optional(t.String()),
      min_price: t.Optional(t.String()),
      max_price: t.Optional(t.String()),
      condition: t.Optional(t.String()),
      sort: t.Optional(t.String()),
      page: t.Optional(t.String()),
      per_page: t.Optional(t.String()),
    }),
  },
);

export default searchModule;
