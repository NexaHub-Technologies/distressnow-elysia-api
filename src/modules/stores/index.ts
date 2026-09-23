/**
 * Stores module.
 *
 * - GET    /stores            public directory (paginated + filters)
 * - GET    /stores/:id        public storefront (UUID)
 * - POST   /stores            seller creates their store (auth, one per user)
 * - PUT    /stores/:id        owner updates the store (auth)
 * - GET    /user/store        authenticated seller's own store (auth)
 * - POST   /stores/:id/follow    follow a store (auth)
 * - DELETE /stores/:id/follow    unfollow a store (auth)
 * - GET    /user/following    stores the user follows (auth)
 */
import { Elysia, t } from "elysia";
import { and, count, desc, eq, gte, ilike, or, sql, type SQL } from "drizzle-orm";
import { db } from "../../db/client";
import {
  adverts,
  markets,
  states,
  storeFollows,
  stores,
  storeViews,
  sublocations,
  users,
} from "../../db/schema";
import { notificationStore } from "../notifications/index";
import { auth } from "../../plugins/auth";

type Store = typeof stores.$inferSelect;
import { created, fail, ok, paginated } from "../../utils/response";
import { buildMeta, parsePagination } from "../../utils/pagination";
import { num, slugify } from "../../utils/marketplace";
import { resolveMarketId, resolveStateId, resolveSublocationId } from "../../utils/lookups";

interface StoreRelations {
  states: Map<number, { uuid: string; name: string; slug: string }>;
  sublocations: Map<number, { uuid: string; name: string; slug: string }>;
  markets: Map<number, { uuid: string; name: string; slug: string }>;
  users: Map<number, { id: number; name: string }>;
}

async function loadStoreRelations(rows: Store[]): Promise<StoreRelations> {
  const stateIds = [...new Set(rows.map((r) => r.stateId).filter((v): v is number => v !== null))];
  const subIds = [...new Set(rows.map((r) => r.sublocationId).filter((v): v is number => v !== null))];
  const marketIds = [...new Set(rows.map((r) => r.marketId).filter((v): v is number => v !== null))];
  const userIds = [...new Set(rows.map((r) => r.userId))];

  const [stateRows, subRows, marketRows, userRows] = await Promise.all([
    db.select({ id: states.id, uuid: states.uuid, name: states.name, slug: states.slug }).from(states),
    db.select({ id: sublocations.id, uuid: sublocations.uuid, name: sublocations.name, slug: sublocations.slug }).from(sublocations),
    db.select({ id: markets.id, uuid: markets.uuid, name: markets.name, slug: markets.slug }).from(markets),
    db.select({ id: users.id, name: users.name }).from(users),
  ]);

  const wantedStates = new Set(stateIds);
  const wantedSubs = new Set(subIds);
  const wantedMarkets = new Set(marketIds);
  const wantedUsers = new Set(userIds);

  return {
    states: new Map(stateRows.filter((r) => wantedStates.has(r.id)).map((r) => [r.id, r])),
    sublocations: new Map(subRows.filter((r) => wantedSubs.has(r.id)).map((r) => [r.id, r])),
    markets: new Map(marketRows.filter((r) => wantedMarkets.has(r.id)).map((r) => [r.id, r])),
    users: new Map(userRows.filter((r) => wantedUsers.has(r.id)).map((r) => [r.id, r])),
  };
}

function serializeStore(store: Store, rel: StoreRelations) {
  return {
    id: store.uuid,
    user: rel.users.get(store.userId) ?? { id: store.userId },
    name: store.name,
    slug: store.slug,
    description: store.description,
    logo_path: store.logoPath,
    banner_path: store.bannerPath,
    phone: store.phone,
    email: store.email,
    whatsapp_number: store.whatsappNumber,
    address: store.address,
    categories: (store.categories as string[] | null) ?? null,
    social_links: (store.socialLinks as Record<string, string> | null) ?? null,
    opening_hours: (store.openingHours as Record<string, string> | null) ?? null,
    is_verified: store.isVerified,
    status: store.status,
    rating: num(store.rating),
    review_count: store.reviewCount,
    listings_count: store.listingsCount,
    followers_count: store.followersCount,
    views_count: store.viewsCount ? Number(store.viewsCount) : 0,
    is_promoted: store.isPromoted ?? false,
    promotion_type: store.promotionType ?? null,
    promotion_expiry: store.promotionExpiry ?? null,
    promoted_at: store.promotedAt ?? null,
    state: store.stateId
      ? (rel.states.get(store.stateId) ?? null)
      : null,
    sublocation: store.sublocationId
      ? (rel.sublocations.get(store.sublocationId) ?? null)
      : null,
    market: store.marketId ? (rel.markets.get(store.marketId) ?? null) : null,
    created_at: store.createdAt,
    updated_at: store.updatedAt,
  };
}

async function uniqueStoreSlug(base: string, ignoreId?: number): Promise<string> {
  let slug = slugify(base);
  if (!slug) slug = "store";
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const candidate = attempt === 0 ? slug : `${slug}-${attempt}`;
    const rows = await db
      .select({ id: stores.id })
      .from(stores)
      .where(eq(stores.slug, candidate))
      .limit(1);
    const hit = rows[0];
    if (!hit || hit.id === ignoreId) return candidate;
  }
  return `${slug}-${Date.now().toString(36)}`;
}

async function findStoreByUuid(uuid: string) {
  const rows = await db.select().from(stores).where(eq(stores.uuid, uuid)).limit(1);
  return rows[0] ?? null;
}

const storeQuerySchema = t.Object({
  q: t.Optional(t.String()),
  state: t.Optional(t.String()),
  sublocation: t.Optional(t.String()),
  market: t.Optional(t.String()),
  category: t.Optional(t.String()),
  page: t.Optional(t.String()),
  per_page: t.Optional(t.String()),
});

const pageQuerySchema = t.Object({
  page: t.Optional(t.String()),
  per_page: t.Optional(t.String()),
});

const storeBodySchema = t.Object({
  name: t.String({ minLength: 1, maxLength: 255 }),
  description: t.Optional(t.String({ maxLength: 2000 })),
  phone: t.Optional(t.String({ maxLength: 20 })),
  email: t.Optional(t.String({ maxLength: 255 })),
  whatsapp_number: t.Optional(t.String({ maxLength: 20 })),
  state_id: t.Optional(t.String()),
  sublocation_id: t.Optional(t.String()),
  market_id: t.Optional(t.String()),
  address: t.Optional(t.String({ maxLength: 500 })),
  categories: t.Optional(t.Array(t.String())),
  social_links: t.Optional(t.Record(t.String(), t.String())),
  opening_hours: t.Optional(t.Record(t.String(), t.String())),
});

const uuidParams = t.Object({ id: t.String({ format: "uuid" }) });

export const storesModule = new Elysia()
  .use(auth)
  .get(
    "/stores",
    async ({ query }) => {
      const { page, perPage, offset } = parsePagination(query);
      const conditions: (SQL | undefined)[] = [eq(stores.status, "active"), eq(stores.isVerified, true)];

      const stateId = await resolveStateId(query.state);
      if (stateId === null) return paginated([], buildMeta(page, perPage, 0));
      if (stateId !== undefined) conditions.push(eq(stores.stateId, stateId));

      const subId = await resolveSublocationId(query.sublocation);
      if (subId === null) return paginated([], buildMeta(page, perPage, 0));
      if (subId !== undefined) conditions.push(eq(stores.sublocationId, subId));

      const marketId = await resolveMarketId(query.market);
      if (marketId === null) return paginated([], buildMeta(page, perPage, 0));
      if (marketId !== undefined) conditions.push(eq(stores.marketId, marketId));

      if (query.category) {
        conditions.push(
          sql`${stores.categories} @> ${JSON.stringify([query.category])}::jsonb`,
        );
      }

      const q = query.q?.trim();
      if (q) {
        const needle = `%${q}%`;
        conditions.push(
          or(ilike(stores.name, needle), ilike(stores.description, needle)),
        );
      }

      const where = and(...conditions);
      const [rows, totalRows] = await Promise.all([
        db.select().from(stores).where(where).orderBy(desc(stores.lastActiveAt)).limit(perPage).offset(offset),
        db.select({ total: count() }).from(stores).where(where),
      ]);
      const rel = await loadStoreRelations(rows);
      return paginated(
        rows.map((store) => serializeStore(store, rel)),
        buildMeta(page, perPage, totalRows[0]?.total ?? 0),
      );
    },
    { query: storeQuerySchema },
  )
  .get(
    "/stores/counts",
    async ({ query }) => {
      const activeStores = await db
        .select({
          id: stores.id,
          stateId: stores.stateId,
          sublocationId: stores.sublocationId,
          marketId: stores.marketId,
        })
        .from(stores)
        .where(eq(stores.status, "active"));

      const total = activeStores.length;
      const stateCountsMap = new Map<number, number>();
      for (const s of activeStores) {
        if (s.stateId !== null) {
          stateCountsMap.set(s.stateId, (stateCountsMap.get(s.stateId) ?? 0) + 1);
        }
      }

      const allStates = await db
        .select({ id: states.id, uuid: states.uuid, name: states.name, slug: states.slug })
        .from(states);

      const statesList = allStates
        .filter((st) => stateCountsMap.has(st.id))
        .map((st) => ({
          state_id: st.id,
          state_name: st.name,
          state_slug: st.slug,
          count: stateCountsMap.get(st.id) ?? 0,
        }))
        .sort((a, b) => b.count - a.count);

      const result: Record<string, unknown> = {
        total,
        states: statesList,
      };

      if (query.state) {
        const stateId = await resolveStateId(query.state);
        if (stateId) {
          const stateStores = activeStores.filter((s) => s.stateId === stateId);
          const subCountsMap = new Map<number, number>();
          for (const s of stateStores) {
            if (s.sublocationId !== null) {
              subCountsMap.set(s.sublocationId, (subCountsMap.get(s.sublocationId) ?? 0) + 1);
            }
          }
          const allSubs = await db
            .select({ id: sublocations.id, name: sublocations.name, slug: sublocations.slug })
            .from(sublocations)
            .where(eq(sublocations.stateId, stateId));

          result.sublocations = allSubs
            .filter((sub) => subCountsMap.has(sub.id))
            .map((sub) => ({
              sublocation_id: sub.id,
              sublocation_name: sub.name,
              sublocation_slug: sub.slug,
              count: subCountsMap.get(sub.id) ?? 0,
            }))
            .sort((a, b) => b.count - a.count);

          if (query.sublocation) {
            const subId = await resolveSublocationId(query.sublocation);
            if (subId) {
              const subStores = stateStores.filter((s) => s.sublocationId === subId);
              const marketCountsMap = new Map<number, number>();
              for (const s of subStores) {
                if (s.marketId !== null) {
                  marketCountsMap.set(s.marketId, (marketCountsMap.get(s.marketId) ?? 0) + 1);
                }
              }
              const allMarkets = await db
                .select({ id: markets.id, name: markets.name, slug: markets.slug })
                .from(markets)
                .where(eq(markets.sublocationId, subId));

              result.markets = allMarkets
                .filter((m) => marketCountsMap.has(m.id))
                .map((m) => ({
                  market_id: m.id,
                  market_name: m.name,
                  market_slug: m.slug,
                  count: marketCountsMap.get(m.id) ?? 0,
                }))
                .sort((a, b) => b.count - a.count);
            }
          }
        }
      }

      return ok(result);
    },
    {
      query: t.Object({
        state: t.Optional(t.String()),
        sublocation: t.Optional(t.String()),
      }),
    },
  )
  .get(
    "/stores/:id",
    async ({ params, set }) => {
      const store = await findStoreByUuid(params.id);
      if (!store) {
        set.status = 404;
        return fail("Store not found.");
      }
      await db
        .update(stores)
        .set({ lastActiveAt: new Date() })
        .where(eq(stores.id, store.id));
      const rel = await loadStoreRelations([store]);
      return ok(serializeStore(store, rel));
    },
    { params: uuidParams },
  )
  .post(
    "/stores",
    async ({ body, currentUser, set }) => {
      if (!currentUser) {
        set.status = 401;
        return fail("Unauthenticated.");
      }
      const existing = await db
        .select({ id: stores.id })
        .from(stores)
        .where(eq(stores.userId, currentUser.id))
        .limit(1);
      if (existing[0]) {
        set.status = 422;
        return fail("You already have a store.");
      }
      const stateId = await resolveStateId(body.state_id);
      if (body.state_id && stateId == null) {
        set.status = 422;
        return fail("Unknown state.");
      }
      const sublocationId = await resolveSublocationId(body.sublocation_id);
      if (body.sublocation_id && sublocationId == null) {
        set.status = 422;
        return fail("Unknown sublocation.");
      }
      const marketId = await resolveMarketId(body.market_id);
      if (body.market_id && marketId == null) {
        set.status = 422;
        return fail("Unknown market.");
      }
      const slug = await uniqueStoreSlug(body.name);
      const inserted = await db
        .insert(stores)
        .values({
          userId: currentUser.id,
          name: body.name,
          slug,
          description: body.description ?? null,
          phone: body.phone ?? null,
          email: body.email ?? null,
          whatsappNumber: body.whatsapp_number ?? null,
          stateId: stateId ?? null,
          sublocationId: sublocationId ?? null,
          marketId: marketId ?? null,
          address: body.address ?? null,
          categories: body.categories ?? null,
          socialLinks: body.social_links ?? null,
          openingHours: body.opening_hours ?? null,
          status: "active",
        })
        .returning();
      const store = inserted[0];
      if (!store) {
        set.status = 500;
        return fail("Could not create store.");
      }
      const rel = await loadStoreRelations([store]);
      set.status = 201;
      return created(serializeStore(store, rel), "Store created successfully.");
    },
    { body: storeBodySchema },
  )
  .put(
    "/stores/:id",
    async ({ params, body, currentUser, set }) => {
      if (!currentUser) {
        set.status = 401;
        return fail("Unauthenticated.");
      }
      const store = await findStoreByUuid(params.id);
      if (!store) {
        set.status = 404;
        return fail("Store not found.");
      }
      if (store.userId !== currentUser.id) {
        set.status = 403;
        return fail("You are not authorized to update this store.");
      }
      const patch: Partial<typeof stores.$inferInsert> = {};
      if (body.name !== undefined) {
        patch.name = body.name;
        if (body.name !== store.name) patch.slug = await uniqueStoreSlug(body.name, store.id);
      }
      if (body.description !== undefined) patch.description = body.description;
      if (body.phone !== undefined) patch.phone = body.phone;
      if (body.email !== undefined) patch.email = body.email;
      if (body.whatsapp_number !== undefined) patch.whatsappNumber = body.whatsapp_number;
      if (body.state_id !== undefined) {
        const stateId = await resolveStateId(body.state_id || undefined);
        if (body.state_id && stateId == null) {
          set.status = 422;
          return fail("Unknown state.");
        }
        patch.stateId = stateId ?? null;
      }
      if (body.sublocation_id !== undefined) {
        const sublocationId = await resolveSublocationId(body.sublocation_id || undefined);
        if (body.sublocation_id && sublocationId == null) {
          set.status = 422;
          return fail("Unknown sublocation.");
        }
        patch.sublocationId = sublocationId ?? null;
      }
      if (body.market_id !== undefined) {
        const marketId = await resolveMarketId(body.market_id || undefined);
        if (body.market_id && marketId == null) {
          set.status = 422;
          return fail("Unknown market.");
        }
        patch.marketId = marketId ?? null;
      }
      if (body.address !== undefined) patch.address = body.address;
      if (body.categories !== undefined) patch.categories = body.categories;
      if (body.social_links !== undefined) patch.socialLinks = body.social_links;
      if (body.opening_hours !== undefined) patch.openingHours = body.opening_hours;

      const updated = await db
        .update(stores)
        .set(patch)
        .where(eq(stores.id, store.id))
        .returning();
      const next = updated[0] ?? store;
      const rel = await loadStoreRelations([next]);
      return ok(serializeStore(next, rel));
    },
    {
      params: uuidParams,
      body: t.Object({
        name: t.Optional(t.String({ minLength: 1, maxLength: 255 })),
        description: t.Optional(t.Union([t.String({ maxLength: 2000 }), t.Null()])),
        phone: t.Optional(t.Union([t.String({ maxLength: 20 }), t.Null()])),
        email: t.Optional(t.Union([t.String({ maxLength: 255 }), t.Null()])),
        whatsapp_number: t.Optional(t.Union([t.String({ maxLength: 20 }), t.Null()])),
        state_id: t.Optional(t.Union([t.String(), t.Null()])),
        sublocation_id: t.Optional(t.Union([t.String(), t.Null()])),
        market_id: t.Optional(t.Union([t.String(), t.Null()])),
        address: t.Optional(t.Union([t.String({ maxLength: 500 }), t.Null()])),
        categories: t.Optional(t.Union([t.Array(t.String()), t.Null()])),
        social_links: t.Optional(t.Union([t.Record(t.String(), t.String()), t.Null()])),
        opening_hours: t.Optional(t.Union([t.Record(t.String(), t.String()), t.Null()])),
      }),
    },
  )
  .get("/user/store", async ({ currentUser, set }) => {
    if (!currentUser) {
      set.status = 401;
      return fail("Unauthenticated.");
    }
    const rows = await db.select().from(stores).where(eq(stores.userId, currentUser.id)).limit(1);
    const store = rows[0];
    if (!store) return ok(null);
    const rel = await loadStoreRelations([store]);
    return ok(serializeStore(store, rel));
  })
  .get("/user/stores", async ({ currentUser, set }) => {
    if (!currentUser) {
      set.status = 401;
      return fail("Unauthenticated.");
    }
    const rows = await db
      .select()
      .from(stores)
      .where(eq(stores.userId, currentUser.id))
      .orderBy(desc(stores.createdAt));
    const rel = await loadStoreRelations(rows);
    return ok(rows.map((s) => serializeStore(s, rel)));
  })
  .post(
    "/stores/:id/promote",
    async ({ params, body, currentUser, userRoles, set }) => {
      if (!currentUser) {
        set.status = 401;
        return fail("Unauthenticated.");
      }
      const store = await findStoreByUuid(params.id);
      if (!store) {
        set.status = 404;
        return fail("Store not found.");
      }
      if (store.userId !== currentUser.id && !userRoles.includes("admin")) {
        set.status = 403;
        return fail("Unauthorized.");
      }

      const packageConfig: Record<string, { days: number; amount: number }> = {
        store_3_days: { days: 3, amount: 3000 },
        "3_days": { days: 3, amount: 3000 },
        store_5_days: { days: 5, amount: 5000 },
        "5_days": { days: 5, amount: 5000 },
        store_1_week: { days: 7, amount: 7500 },
        "7_days": { days: 7, amount: 7500 },
        store_1_month: { days: 30, amount: 25000 },
        "30_days": { days: 30, amount: 25000 },
      };

      const pkg = packageConfig[body.promotion_package] ?? { days: 7, amount: 7500 };
      const now = new Date();
      const expiry = new Date(now.getTime() + pkg.days * 24 * 60 * 60 * 1000);

      await db
        .update(stores)
        .set({
          status: "active",
          isPromoted: true,
          promotionType: body.promotion_package,
          promotedAt: now,
          promotionExpiry: expiry,
        })
        .where(eq(stores.id, store.id));

      await db.insert(adverts).values({
        userId: currentUser.id,
        storeId: store.uuid,
        title: store.name,
        description: store.description,
        imagePath: store.bannerPath ?? store.logoPath,
        targetUrl: `/store/${store.uuid}`,
        placement: "banner",
        packageId: body.promotion_package,
        durationDays: pkg.days,
        amountPaid: String(pkg.amount),
        paymentReference: body.payment_reference ?? null,
        status: "active",
        publishedAt: now,
        expiresAt: expiry,
      });

      const updated = await findStoreByUuid(params.id);
      const rel = await loadStoreRelations([updated!]);
      return ok(serializeStore(updated!, rel), "Store promoted successfully.");
    },
    {
      params: uuidParams,
      body: t.Object({
        promotion_package: t.String(),
        payment_reference: t.Optional(t.String()),
      }),
    },
  )
  .post(
    "/stores/:id/view",
    async ({ params, currentUser, request, set }) => {
      const store = await findStoreByUuid(params.id);
      if (!store) {
        set.status = 404;
        return fail("Store not found.");
      }

      const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "127.0.0.1";
      const userAgent = request.headers.get("user-agent") || "";
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);

      const recent = await db
        .select({ id: storeViews.id })
        .from(storeViews)
        .where(
          and(
            eq(storeViews.storeId, store.id),
            currentUser
              ? eq(storeViews.viewerId, currentUser.id)
              : eq(storeViews.ipAddress, ip),
            gte(storeViews.viewedAt, fiveMinutesAgo),
          ),
        )
        .limit(1);

      let currentViews = store.viewsCount ? Number(store.viewsCount) : 0;

      if (!recent[0]) {
        await db.insert(storeViews).values({
          storeId: store.id,
          viewerId: currentUser ? currentUser.id : null,
          ipAddress: ip,
          userAgent,
          viewedAt: new Date(),
        });

        const updated = await db
          .update(stores)
          .set({ viewsCount: sql`${stores.viewsCount} + 1` })
          .where(eq(stores.id, store.id))
          .returning({ viewsCount: stores.viewsCount });

        currentViews = updated[0]?.viewsCount ? Number(updated[0].viewsCount) : currentViews + 1;

        if (currentUser && store.userId !== currentUser.id) {
          notificationStore.create({
            userId: String(store.userId),
            type: "store_viewed",
            title: "Store View Notice",
            body: `${currentUser.name} viewed your store '${store.name}'.`,
            data: {
              store_id: store.id,
              store_uuid: store.uuid,
              store_name: store.name,
              target_type: "store",
              target_id: store.uuid || store.id,
              target_name: store.name,
              viewer_id: currentUser.id,
              viewer_name: currentUser.name,
              viewer_avatar: (currentUser as any).avatar_url ?? null,
              chat_link: `/chat?recipient_id=${currentUser.id}`,
              profile_url: `/user/${currentUser.id}`,
            },
          });
        }
      }

      return ok({ views_count: currentViews, throttled: Boolean(recent[0]) }, "Store view recorded");
    },
    { params: uuidParams },
  )
  .get(
    "/user/stores/:id/analytics",
    async ({ params, currentUser, userRoles, query, set }) => {
      if (!currentUser) {
        set.status = 401;
        return fail("Unauthenticated.");
      }
      const store = await findStoreByUuid(params.id);
      if (!store) {
        set.status = 404;
        return fail("Store not found.");
      }
      if (store.userId !== currentUser.id && !userRoles.includes("admin")) {
        set.status = 403;
        return fail("Unauthorized access to store analytics");
      }

      const { page, perPage, offset } = parsePagination(query);
      const where = and(eq(storeViews.storeId, store.id), sql`${storeViews.viewerId} IS NOT NULL`);
      const [viewRows, totalRows] = await Promise.all([
        db
          .select()
          .from(storeViews)
          .where(where)
          .orderBy(desc(storeViews.viewedAt))
          .limit(perPage)
          .offset(offset),
        db.select({ total: count() }).from(storeViews).where(where),
      ]);

      const viewerIds = [...new Set(viewRows.map((v) => v.viewerId).filter((id): id is number => id !== null))];
      const viewerRows = viewerIds.length > 0 ? await db.select({ id: users.id, name: users.name, email: users.email, avatarPath: users.avatarPath }).from(users) : [];
      const viewerMap = new Map(viewerRows.map((u) => [u.id, u]));

      const recentViewers = viewRows.map((v) => ({
        id: v.id,
        viewer: v.viewerId ? viewerMap.get(v.viewerId) ?? { id: v.viewerId } : null,
        viewed_at: v.viewedAt,
      }));

      return ok({
        store: {
          id: store.uuid,
          name: store.name,
          views_count: store.viewsCount ? Number(store.viewsCount) : 0,
          followers_count: store.followersCount,
        },
        recent_viewers: recentViewers,
        meta: buildMeta(page, perPage, totalRows[0]?.total ?? 0),
      });
    },
    { params: uuidParams, query: pageQuerySchema },
  )
  .post(
    "/stores/:id/follow",
    async ({ params, currentUser, set }) => {
      if (!currentUser) {
        set.status = 401;
        return fail("Unauthenticated.");
      }
      const store = await findStoreByUuid(params.id);
      if (!store) {
        set.status = 404;
        return fail("Store not found.");
      }
      const existing = await db
        .select({ id: storeFollows.id })
        .from(storeFollows)
        .where(and(eq(storeFollows.userId, currentUser.id), eq(storeFollows.storeId, store.id)))
        .limit(1);
      if (existing[0]) {
        return ok(
          { followers_count: store.followersCount },
          "Already following this store.",
        );
      }
      await db.insert(storeFollows).values({ userId: currentUser.id, storeId: store.id });
      const bumped = await db
        .update(stores)
        .set({ followersCount: sql`${stores.followersCount} + 1` })
        .where(eq(stores.id, store.id))
        .returning({ followersCount: stores.followersCount });
      set.status = 201;
      return created(
        { followers_count: bumped[0]?.followersCount ?? store.followersCount + 1 },
        "Store followed.",
      );
    },
    { params: uuidParams },
  )
  .delete(
    "/stores/:id/follow",
    async ({ params, currentUser, set }) => {
      if (!currentUser) {
        set.status = 401;
        return fail("Unauthenticated.");
      }
      const store = await findStoreByUuid(params.id);
      if (!store) {
        set.status = 404;
        return fail("Store not found.");
      }
      const existing = await db
        .select({ id: storeFollows.id })
        .from(storeFollows)
        .where(and(eq(storeFollows.userId, currentUser.id), eq(storeFollows.storeId, store.id)))
        .limit(1);
      const follow = existing[0];
      if (!follow) {
        set.status = 404;
        return fail("You are not following this store.");
      }
      await db.delete(storeFollows).where(eq(storeFollows.id, follow.id));
      const lowered = await db
        .update(stores)
        .set({ followersCount: sql`GREATEST(${stores.followersCount} - 1, 0)` })
        .where(eq(stores.id, store.id))
        .returning({ followersCount: stores.followersCount });
      return ok(
        { followers_count: lowered[0]?.followersCount ?? 0 },
        "Store unfollowed.",
      );
    },
    { params: uuidParams },
  )
  .post(
    "/stores/:id/unfollow",
    async ({ params, currentUser, set }) => {
      if (!currentUser) {
        set.status = 401;
        return fail("Unauthenticated.");
      }
      const store = await findStoreByUuid(params.id);
      if (!store) {
        set.status = 404;
        return fail("Store not found.");
      }
      const existing = await db
        .select({ id: storeFollows.id })
        .from(storeFollows)
        .where(and(eq(storeFollows.userId, currentUser.id), eq(storeFollows.storeId, store.id)))
        .limit(1);
      const follow = existing[0];
      if (!follow) {
        set.status = 404;
        return fail("You are not following this store.");
      }
      await db.delete(storeFollows).where(eq(storeFollows.id, follow.id));
      const lowered = await db
        .update(stores)
        .set({ followersCount: sql`GREATEST(${stores.followersCount} - 1, 0)` })
        .where(eq(stores.id, store.id))
        .returning({ followersCount: stores.followersCount });
      return ok(
        { followers_count: lowered[0]?.followersCount ?? 0 },
        "Store unfollowed.",
      );
    },
    { params: uuidParams },
  )
  .get(
    "/stores/:id/followers",
    async ({ params, query, set }) => {
      const store = await findStoreByUuid(params.id);
      if (!store) {
        set.status = 404;
        return fail("Store not found.");
      }
      const { page, perPage, offset } = parsePagination(query);
      const where = eq(storeFollows.storeId, store.id);
      const [followRows, totalRows] = await Promise.all([
        db.select().from(storeFollows).where(where).orderBy(desc(storeFollows.createdAt)).limit(perPage).offset(offset),
        db.select({ total: count() }).from(storeFollows).where(where),
      ]);
      const userIds = [...new Set(followRows.map((f) => f.userId))];
      const userRows = userIds.length > 0 ? await db.select({ id: users.id, name: users.name, email: users.email, avatarPath: users.avatarPath }).from(users) : [];
      const userMap = new Map(userRows.map((u) => [u.id, u]));

      const data = followRows.map((f) => ({
        user: userMap.get(f.userId) ?? { id: f.userId },
        created_at: f.createdAt,
      }));
      return paginated(data, buildMeta(page, perPage, totalRows[0]?.total ?? 0));
    },
    { params: uuidParams, query: pageQuerySchema },
  )
  .get(
    "/user/following",
    async ({ currentUser, query, set }) => {
      if (!currentUser) {
        set.status = 401;
        return fail("Unauthenticated.");
      }
      const { page, perPage, offset } = parsePagination(query);
      const where = eq(storeFollows.userId, currentUser.id);
      const [follows, totalRows] = await Promise.all([
        db.select().from(storeFollows).where(where).orderBy(desc(storeFollows.createdAt)).limit(perPage).offset(offset),
        db.select({ total: count() }).from(storeFollows).where(where),
      ]);
      const storeIds = [...new Set(follows.map((f) => f.storeId))];
      const storeRows = await db.select().from(stores);
      const wanted = new Set(storeIds);
      const matched = storeRows.filter((s) => wanted.has(s.id));
      const rel = await loadStoreRelations(matched);
      const followedAtByStore = new Map(follows.map((f) => [f.storeId, f.createdAt]));
      const data = matched.map((store) => ({
        ...serializeStore(store, rel),
        followed_at: followedAtByStore.get(store.id) ?? null,
      }));
      return paginated(data, buildMeta(page, perPage, totalRows[0]?.total ?? 0));
    },
    { query: pageQuerySchema },
  )
  .get(
    "/user/followed-stores",
    async ({ currentUser, query, set }) => {
      if (!currentUser) {
        set.status = 401;
        return fail("Unauthenticated.");
      }
      const { page, perPage, offset } = parsePagination(query);
      const where = eq(storeFollows.userId, currentUser.id);
      const [follows, totalRows] = await Promise.all([
        db.select().from(storeFollows).where(where).orderBy(desc(storeFollows.createdAt)).limit(perPage).offset(offset),
        db.select({ total: count() }).from(storeFollows).where(where),
      ]);
      const storeIds = [...new Set(follows.map((f) => f.storeId))];
      const storeRows = await db.select().from(stores);
      const wanted = new Set(storeIds);
      const matched = storeRows.filter((s) => wanted.has(s.id));
      const rel = await loadStoreRelations(matched);
      const followedAtByStore = new Map(follows.map((f) => [f.storeId, f.createdAt]));
      const data = matched.map((store) => ({
        ...serializeStore(store, rel),
        followed_at: followedAtByStore.get(store.id) ?? null,
      }));
      return paginated(data, buildMeta(page, perPage, totalRows[0]?.total ?? 0));
    },
    { query: pageQuerySchema },
  );

export default storesModule;
