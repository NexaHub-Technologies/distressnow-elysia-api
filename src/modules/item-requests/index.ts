// src/modules/item-requests/index.ts
//
// "Request an Item" — buyer posts a want; matched sellers respond with offers.
//
// Endpoints (mounted under /item-requests):
//   GET    /item-requests/browse         — browse open requests (for sellers)
//   POST   /item-requests                — create a request + trigger broadcast
//   GET    /item-requests/my             — buyer's own requests
//   GET    /item-requests/offers         — all offers received on buyer's requests
//   GET    /item-requests/:id            — view single request with responses
//   PATCH  /item-requests/:id/status     — mark fulfilled / cancelled
//   POST   /item-requests/:id/responses  — seller submits an offer

import { Elysia, t } from "elysia";
import { and, asc, count, desc, eq, gte, ilike, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { db } from "../../db/client";
import {
  categories,
  itemRequestResponses,
  itemRequests,
  listings,
  listingImages,
  states,
  stores,
  subcategories,
  sublocations,
  users,
} from "../../db/schema";
import { auth } from "../../plugins/auth";
import { created, fail, ok, paginated } from "../../utils/response";
import { buildMeta, parsePagination } from "../../utils/pagination";
import { isUuid, num } from "../../utils/marketplace";
import {
  resolveCategoryId,
  resolveStateId,
  resolveSubcategoryId,
  resolveSublocationId,
} from "../../utils/lookups";
import { notificationStore } from "../notifications/index";

// ── In-Memory Store & Row Types for Tests & Fallbacks ────────────────────────

export interface ItemRequestRow {
  id: number;
  uuid: string;
  userId: number;
  title: string;
  description: string;
  categoryId: number | null;
  subcategoryId: number | null;
  stateId: number | null;
  sublocationId: number | null;
  budgetMin: number | null;
  budgetMax: number | null;
  images: string[];
  status: string;
  responsesCount: number;
  broadcastCount: number;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ItemRequestResponseRow {
  id: number;
  uuid: string;
  itemRequestId: number;
  storeId: number;
  userId: number;
  price: number;
  message: string;
  listingId: number | null;
  images: string[];
  status: string;
  createdAt: string;
  updatedAt: string;
}

export class ItemRequestMemoryStore {
  requests: ItemRequestRow[] = [];
  responses: ItemRequestResponseRow[] = [];
  private reqSeq = 1;
  private resSeq = 1;

  reset(): void {
    this.requests = [];
    this.responses = [];
    this.reqSeq = 1;
    this.resSeq = 1;
  }

  createRequest(input: Partial<ItemRequestRow> & { userId: number; title: string; description: string }): ItemRequestRow {
    const row: ItemRequestRow = {
      id: this.reqSeq++,
      uuid: crypto.randomUUID(),
      userId: input.userId,
      title: input.title,
      description: input.description,
      categoryId: input.categoryId ?? null,
      subcategoryId: input.subcategoryId ?? null,
      stateId: input.stateId ?? null,
      sublocationId: input.sublocationId ?? null,
      budgetMin: input.budgetMin ?? null,
      budgetMax: input.budgetMax ?? null,
      images: input.images ?? [],
      status: input.status ?? "open",
      responsesCount: 0,
      broadcastCount: 0,
      expiresAt: input.expiresAt ?? null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.requests.push(row);
    return row;
  }

  findRequestByUuidOrId(ref: string | number): ItemRequestRow | null {
    if (typeof ref === "number" || /^\d+$/.test(String(ref))) {
      const numId = Number(ref);
      return this.requests.find((r) => r.id === numId) ?? null;
    }
    return this.requests.find((r) => r.uuid === ref) ?? null;
  }

  createResponse(input: Partial<ItemRequestResponseRow> & { itemRequestId: number; storeId: number; userId: number; price: number; message: string }): ItemRequestResponseRow {
    const row: ItemRequestResponseRow = {
      id: this.resSeq++,
      uuid: crypto.randomUUID(),
      itemRequestId: input.itemRequestId,
      storeId: input.storeId,
      userId: input.userId,
      price: input.price,
      message: input.message,
      listingId: input.listingId ?? null,
      images: input.images ?? [],
      status: input.status ?? "pending",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.responses.push(row);
    const req = this.requests.find((r) => r.id === input.itemRequestId);
    if (req) {
      req.responsesCount += 1;
    }
    return row;
  }

  getResponsesForRequest(requestId: number): ItemRequestResponseRow[] {
    return this.responses.filter((r) => r.itemRequestId === requestId);
  }
}

export const memoryItemRequestStore = new ItemRequestMemoryStore();

// ── Two-Pool Store Matching Engine ──────────────────────────────────────────

export function scoreCandidateStore(
  itemRequest: {
    categoryId?: number | null;
    stateId?: number | null;
    sublocationId?: number | null;
  },
  store: {
    sublocationId?: number | null;
    stateId?: number | null;
    categories?: unknown;
    isPromoted?: boolean | null;
    promotionExpiry?: string | Date | null;
  },
  now: Date = new Date(),
): { score: number; promoted: boolean } {
  let score = 0;

  // Location Proximity (+40 sublocation, +20 state)
  if (itemRequest.sublocationId && store.sublocationId === itemRequest.sublocationId) {
    score += 40;
  } else if (itemRequest.stateId && store.stateId === itemRequest.stateId) {
    score += 20;
  }

  // Category affinity (+30)
  if (itemRequest.categoryId && Array.isArray(store.categories)) {
    const catStr = String(itemRequest.categoryId);
    if (store.categories.some((c) => String(c).includes(catStr))) {
      score += 30;
    }
  }

  const isPromotedActive =
    Boolean(store.isPromoted) &&
    store.promotionExpiry !== null &&
    store.promotionExpiry !== undefined &&
    new Date(store.promotionExpiry) > now;

  return {
    score,
    promoted: isPromotedActive,
  };
}

export async function matchAndBroadcastItemRequest(
  itemRequest: {
    id: number;
    uuid: string;
    userId: number;
    title: string;
    categoryId: number | null;
    subcategoryId: number | null;
    stateId: number | null;
    sublocationId: number | null;
    budgetMin?: unknown;
    budgetMax?: unknown;
  },
): Promise<number> {
  try {
    // 1. Candidate stores: active stores not owned by the requester
    const candidates = await db
      .select({
        id: stores.id,
        uuid: stores.uuid,
        userId: stores.userId,
        name: stores.name,
        stateId: stores.stateId,
        sublocationId: stores.sublocationId,
        isPromoted: stores.isPromoted,
        promotionExpiry: stores.promotionExpiry,
        categories: stores.categories,
      })
      .from(stores)
      .where(and(eq(stores.status, "active"), sql`${stores.userId} != ${itemRequest.userId}`));

    if (candidates.length === 0) return 0;

    // 2. Score candidates
    const now = new Date();
    const scored = candidates
      .map((store) => {
        const { score, promoted } = scoreCandidateStore(itemRequest, store, now);
        return {
          store,
          score,
          promoted,
        };
      })
      .filter((item) => item.score > 0);

    // 3. Two-pool selection: up to 15 promoted + organic up to total 30
    const promoted = scored
      .filter((s) => s.promoted)
      .sort((a, b) => b.score - a.score)
      .slice(0, 15);

    const promotedIds = new Set(promoted.map((p) => p.store.id));
    const remainingSlots = 30 - promoted.length;

    const organic = scored
      .filter((s) => !s.promoted && !promotedIds.has(s.store.id))
      .sort((a, b) => b.score - a.score)
      .slice(0, remainingSlots);

    const finalMatches = [...promoted, ...organic];

    // 4. Send notification to store owners
    let notifiedCount = 0;
    for (const match of finalMatches) {
      notificationStore.create({
        userId: String(match.store.userId),
        type: "item_request_broadcast",
        title: "🔔 New Item Request",
        body: `A buyer is looking for "${itemRequest.title}". Tap to view and send your offer.`,
        data: {
          request_uuid: itemRequest.uuid,
          request_title: itemRequest.title,
          store_id: match.store.id,
          store_uuid: match.store.uuid,
          promoted: match.promoted,
          score: match.score,
          url: `/item-requests/${itemRequest.uuid}`,
        },
      });
      notifiedCount++;
    }

    // 5. Update broadcast_count
    await db
      .update(itemRequests)
      .set({ broadcastCount: notifiedCount })
      .where(eq(itemRequests.id, itemRequest.id));

    return notifiedCount;
  } catch {
    return 0;
  }
}

// ── Serialization Helpers ───────────────────────────────────────────────────

interface RequestRelations {
  categories: Map<number, { id: number; name: string; slug: string }>;
  subcategories: Map<number, { id: number; name: string; slug: string }>;
  states: Map<number, { id: number; name: string; slug: string }>;
  sublocations: Map<number, { id: number; name: string; slug: string }>;
  users: Map<number, { id: number; name: string; avatarUrl: string | null }>;
}

async function loadRequestRelations(reqs: Array<{ categoryId: number | null; subcategoryId: number | null; stateId: number | null; sublocationId: number | null; userId: number }>): Promise<RequestRelations> {
  const catIds = [...new Set(reqs.map((r) => r.categoryId).filter((v): v is number => v !== null))];
  const subCatIds = [...new Set(reqs.map((r) => r.subcategoryId).filter((v): v is number => v !== null))];
  const stateIds = [...new Set(reqs.map((r) => r.stateId).filter((v): v is number => v !== null))];
  const sublocIds = [...new Set(reqs.map((r) => r.sublocationId).filter((v): v is number => v !== null))];
  const userIds = [...new Set(reqs.map((r) => r.userId))];

  const [catRows, subCatRows, stateRows, sublocRows, userRows] = await Promise.all([
    catIds.length > 0 ? db.select({ id: categories.id, name: categories.name, slug: categories.slug }).from(categories).where(inArray(categories.id, catIds)) : [],
    subCatIds.length > 0 ? db.select({ id: subcategories.id, name: subcategories.name, slug: subcategories.slug }).from(subcategories).where(inArray(subcategories.id, subCatIds)) : [],
    stateIds.length > 0 ? db.select({ id: states.id, name: states.name, slug: states.slug }).from(states).where(inArray(states.id, stateIds)) : [],
    sublocIds.length > 0 ? db.select({ id: sublocations.id, name: sublocations.name, slug: sublocations.slug }).from(sublocations).where(inArray(sublocations.id, sublocIds)) : [],
    userIds.length > 0 ? db.select({ id: users.id, name: users.name, avatarUrl: users.avatarPath }).from(users).where(inArray(users.id, userIds)) : [],
  ]);

  return {
    categories: new Map(catRows.map((r) => [r.id, r])),
    subcategories: new Map(subCatRows.map((r) => [r.id, r])),
    states: new Map(stateRows.map((r) => [r.id, r])),
    sublocations: new Map(sublocRows.map((r) => [r.id, r])),
    users: new Map(userRows.map((r) => [r.id, r])),
  };
}

function serializeItemRequest(
  req: typeof itemRequests.$inferSelect,
  rel: RequestRelations,
  responses?: unknown[],
) {
  return {
    id: req.id,
    uuid: req.uuid,
    title: req.title,
    description: req.description,
    category: req.categoryId ? rel.categories.get(req.categoryId) ?? null : null,
    subcategory: req.subcategoryId ? rel.subcategories.get(req.subcategoryId) ?? null : null,
    state: req.stateId ? rel.states.get(req.stateId) ?? null : null,
    sublocation: req.sublocationId ? rel.sublocations.get(req.sublocationId) ?? null : null,
    budget_min: req.budgetMin ? num(req.budgetMin) : null,
    budget_max: req.budgetMax ? num(req.budgetMax) : null,
    images: (req.images as string[] | null) ?? [],
    status: req.status,
    responses_count: req.responsesCount,
    broadcast_count: req.broadcastCount,
    expires_at: req.expiresAt ? new Date(req.expiresAt).toISOString() : null,
    created_at: req.createdAt ? new Date(req.createdAt).toISOString() : null,
    updated_at: req.updatedAt ? new Date(req.updatedAt).toISOString() : null,
    user: rel.users.get(req.userId) ?? { id: req.userId, name: "", avatarUrl: null },
    ...(responses !== undefined ? { responses } : {}),
  };
}

// ── Elysia Item Requests Module ─────────────────────────────────────────────

export const itemRequestsModule = new Elysia()
  .use(auth)

  // 1. GET /item-requests/browse — public browse for sellers
  .get(
    "/item-requests/browse",
    async ({ query }) => {
      const { page, perPage, offset } = parsePagination(query);
      const conditions = [eq(itemRequests.status, "open")];

      if (query.state_id) {
        const resolvedStateId = await resolveStateId(query.state_id);
        if (resolvedStateId) {
          conditions.push(or(eq(itemRequests.stateId, resolvedStateId), isNull(itemRequests.stateId))!);
        }
      }

      if (query.category_id) {
        const resolvedCatId = await resolveCategoryId(query.category_id);
        if (resolvedCatId) {
          conditions.push(or(eq(itemRequests.categoryId, resolvedCatId), isNull(itemRequests.categoryId))!);
        }
      }

      if (query.search) {
        const needle = `%${query.search}%`;
        conditions.push(or(ilike(itemRequests.title, needle), ilike(itemRequests.description, needle))!);
      }

      const where = and(...conditions);
      const [rows, totalRows] = await Promise.all([
        db
          .select()
          .from(itemRequests)
          .where(where)
          .orderBy(desc(itemRequests.createdAt))
          .limit(perPage)
          .offset(offset),
        db.select({ total: count() }).from(itemRequests).where(where),
      ]);

      const rel = await loadRequestRelations(rows);
      const data = rows.map((r) => serializeItemRequest(r, rel));

      return paginated(data, buildMeta(page, perPage, totalRows[0]?.total ?? 0));
    },
    {
      query: t.Object({
        state_id: t.Optional(t.String()),
        category_id: t.Optional(t.String()),
        search: t.Optional(t.String()),
        page: t.Optional(t.Union([t.String(), t.Number()])),
        per_page: t.Optional(t.Union([t.String(), t.Number()])),
      }),
    },
  )

  // 2. POST /item-requests — buyer creates request
  .post(
    "/item-requests",
    async ({ body, currentUser, set }) => {
      if (!currentUser) {
        set.status = 401;
        return fail("Unauthenticated.");
      }

      const categoryId = body.category_id ? await resolveCategoryId(String(body.category_id)) : null;
      const subcategoryId = body.subcategory_id ? await resolveSubcategoryId(String(body.subcategory_id)) : null;
      const stateId = body.state_id ? await resolveStateId(String(body.state_id)) : null;
      const sublocationId = body.sublocation_id ? await resolveSublocationId(String(body.sublocation_id)) : null;

      const inserted = await db
        .insert(itemRequests)
        .values({
          userId: currentUser.id,
          title: body.title,
          description: body.description,
          categoryId: categoryId ?? null,
          subcategoryId: subcategoryId ?? null,
          stateId: stateId ?? null,
          sublocationId: sublocationId ?? null,
          budgetMin: body.budget_min !== undefined ? String(body.budget_min) : null,
          budgetMax: body.budget_max !== undefined ? String(body.budget_max) : null,
          images: body.images ?? [],
          status: "open",
        })
        .returning();

      const createdReq = inserted[0];
      if (!createdReq) {
        set.status = 500;
        return fail("Failed to create item request.");
      }

      // Trigger store matching & broadcast notifications
      await matchAndBroadcastItemRequest(createdReq);

      const freshReq = (await db.select().from(itemRequests).where(eq(itemRequests.id, createdReq.id)).limit(1))[0]!;
      const rel = await loadRequestRelations([freshReq]);

      set.status = 201;
      return created(
        serializeItemRequest(freshReq, rel),
        "Item request created and broadcast to matching stores.",
      );
    },
    {
      body: t.Object({
        title: t.String({ maxLength: 255 }),
        description: t.String({ maxLength: 2000 }),
        category_id: t.Optional(t.Union([t.String(), t.Number()])),
        subcategory_id: t.Optional(t.Union([t.String(), t.Number()])),
        state_id: t.Optional(t.Union([t.String(), t.Number()])),
        sublocation_id: t.Optional(t.Union([t.String(), t.Number()])),
        budget_min: t.Optional(t.Number({ minimum: 0 })),
        budget_max: t.Optional(t.Number({ minimum: 0 })),
        images: t.Optional(t.Array(t.String({ maxLength: 500 }))),
      }),
    },
  )

  // 3. GET /item-requests/my — buyer's own requests
  .get(
    "/item-requests/my",
    async ({ currentUser, query, set }) => {
      if (!currentUser) {
        set.status = 401;
        return fail("Unauthenticated.");
      }

      const { page, perPage, offset } = parsePagination(query);
      const where = eq(itemRequests.userId, currentUser.id);

      const [rows, totalRows] = await Promise.all([
        db
          .select()
          .from(itemRequests)
          .where(where)
          .orderBy(desc(itemRequests.createdAt))
          .limit(perPage)
          .offset(offset),
        db.select({ total: count() }).from(itemRequests).where(where),
      ]);

      const rel = await loadRequestRelations(rows);
      const data = rows.map((r) => serializeItemRequest(r, rel));

      return paginated(data, buildMeta(page, perPage, totalRows[0]?.total ?? 0));
    },
    {
      query: t.Object({
        page: t.Optional(t.Union([t.String(), t.Number()])),
        per_page: t.Optional(t.Union([t.String(), t.Number()])),
      }),
    },
  )

  // 4. GET /item-requests/offers — offers received on buyer's requests
  .get(
    "/item-requests/offers",
    async ({ currentUser, query, set }) => {
      if (!currentUser) {
        set.status = 401;
        return fail("Unauthenticated.");
      }

      const { page, perPage, offset } = parsePagination(query);

      // Find all item request IDs owned by buyer
      const myReqs = await db
        .select({ id: itemRequests.id, uuid: itemRequests.uuid, title: itemRequests.title })
        .from(itemRequests)
        .where(eq(itemRequests.userId, currentUser.id));

      if (myReqs.length === 0) {
        return paginated([], buildMeta(page, perPage, 0));
      }

      const reqMap = new Map(myReqs.map((r) => [r.id, r]));
      const myReqIds = myReqs.map((r) => r.id);

      const conditions = [inArray(itemRequestResponses.itemRequestId, myReqIds)];

      if (query.request_uuid) {
        const targetReq = myReqs.find((r) => r.uuid === query.request_uuid);
        if (targetReq) {
          conditions.push(eq(itemRequestResponses.itemRequestId, targetReq.id));
        } else {
          return paginated([], buildMeta(page, perPage, 0));
        }
      }

      if (query.status && query.status !== "all") {
        conditions.push(eq(itemRequestResponses.status, query.status));
      }

      if (query.min_price) {
        conditions.push(gte(itemRequestResponses.price, String(query.min_price)));
      }

      if (query.max_price) {
        conditions.push(lte(itemRequestResponses.price, String(query.max_price)));
      }

      if (query.search) {
        conditions.push(ilike(itemRequestResponses.message, `%${query.search}%`));
      }

      const where = and(...conditions);
      const sortField = query.sort === "price" ? itemRequestResponses.price : itemRequestResponses.createdAt;
      const order = query.sort_dir === "asc" ? asc(sortField) : desc(sortField);

      const [rows, totalRows] = await Promise.all([
        db
          .select()
          .from(itemRequestResponses)
          .where(where)
          .orderBy(order)
          .limit(perPage)
          .offset(offset),
        db.select({ total: count() }).from(itemRequestResponses).where(where),
      ]);

      const storeIds = [...new Set(rows.map((r) => r.storeId))];
      const userIds = [...new Set(rows.map((r) => r.userId))];
      const listingIds = [...new Set(rows.map((r) => r.listingId).filter((v): v is number => v !== null))];

      const [storeRows, userRows, listingRows] = await Promise.all([
        storeIds.length > 0
          ? db
              .select({
                id: stores.id,
                uuid: stores.uuid,
                name: stores.name,
                slug: stores.slug,
                logoUrl: stores.logoPath,
                isVerified: stores.isVerified,
                rating: stores.rating,
                isPromoted: stores.isPromoted,
              })
              .from(stores)
              .where(inArray(stores.id, storeIds))
          : [],
        userIds.length > 0
          ? db
              .select({
                id: users.id,
                name: users.name,
              })
              .from(users)
              .where(inArray(users.id, userIds))
          : [],
        listingIds.length > 0
          ? db
              .select({
                id: listings.id,
                uuid: listings.uuid,
                title: listings.title,
                price: listings.price,
              })
              .from(listings)
              .where(inArray(listings.id, listingIds))
          : [],
      ]);

      const storeMap = new Map(storeRows.map((s) => [s.id, s]));
      const userMap = new Map(userRows.map((u) => [u.id, u]));
      const listingMap = new Map(listingRows.map((l) => [l.id, l]));

      const data = rows
        .filter((r) => {
          if (query.verified_only === "true" || query.verified_only === "1") {
            const st = storeMap.get(r.storeId);
            return st?.isVerified === true;
          }
          return true;
        })
        .map((r) => ({
          id: r.id,
          uuid: r.uuid,
          item_request_id: r.itemRequestId,
          price: num(r.price),
          message: r.message,
          images: (r.images as string[] | null) ?? [],
          status: r.status,
          created_at: r.createdAt ? new Date(r.createdAt).toISOString() : null,
          updated_at: r.updatedAt ? new Date(r.updatedAt).toISOString() : null,
          store: storeMap.get(r.storeId) ?? { id: r.storeId },
          user: userMap.get(r.userId) ?? { id: r.userId },
          listing: r.listingId ? listingMap.get(r.listingId) ?? null : null,
          item_request: reqMap.get(r.itemRequestId) ?? null,
        }));

      return paginated(data, buildMeta(page, perPage, totalRows[0]?.total ?? 0));
    },
    {
      query: t.Object({
        request_uuid: t.Optional(t.String()),
        status: t.Optional(t.String()),
        min_price: t.Optional(t.Union([t.String(), t.Number()])),
        max_price: t.Optional(t.Union([t.String(), t.Number()])),
        verified_only: t.Optional(t.String()),
        search: t.Optional(t.String()),
        sort: t.Optional(t.String()),
        sort_dir: t.Optional(t.String()),
        page: t.Optional(t.Union([t.String(), t.Number()])),
        per_page: t.Optional(t.Union([t.String(), t.Number()])),
      }),
    },
  )

  // 5. GET /item-requests/:id — view single request with responses
  .get(
    "/item-requests/:id",
    async ({ params, set }) => {
      const isParamUuid = isUuid(params.id);
      const isParamId = /^\d+$/.test(params.id);

      const where = isParamUuid
        ? eq(itemRequests.uuid, params.id)
        : isParamId
          ? eq(itemRequests.id, Number(params.id))
          : null;

      if (!where) {
        set.status = 404;
        return fail("Item request not found.");
      }

      const rows = await db.select().from(itemRequests).where(where).limit(1);
      const req = rows[0];
      if (!req) {
        set.status = 404;
        return fail("Item request not found.");
      }

      const [rel, respRows] = await Promise.all([
        loadRequestRelations([req]),
        db
          .select()
          .from(itemRequestResponses)
          .where(eq(itemRequestResponses.itemRequestId, req.id))
          .orderBy(desc(itemRequestResponses.createdAt)),
      ]);

      const storeIds = [...new Set(respRows.map((r) => r.storeId))];
      const userIds = [...new Set(respRows.map((r) => r.userId))];
      const listingIds = [...new Set(respRows.map((r) => r.listingId).filter((v): v is number => v !== null))];

      const [storeRows, userRows, listingRows] = await Promise.all([
        storeIds.length > 0
          ? db
              .select({
                id: stores.id,
                uuid: stores.uuid,
                name: stores.name,
                slug: stores.slug,
                logoUrl: stores.logoPath,
                isVerified: stores.isVerified,
                rating: stores.rating,
                isPromoted: stores.isPromoted,
              })
              .from(stores)
              .where(inArray(stores.id, storeIds))
          : [],
        userIds.length > 0
          ? db
              .select({
                id: users.id,
                name: users.name,
              })
              .from(users)
              .where(inArray(users.id, userIds))
          : [],
        listingIds.length > 0
          ? db
              .select({
                id: listings.id,
                uuid: listings.uuid,
                title: listings.title,
                price: listings.price,
              })
              .from(listings)
              .where(inArray(listings.id, listingIds))
          : [],
      ]);

      const storeMap = new Map(storeRows.map((s) => [s.id, s]));
      const userMap = new Map(userRows.map((u) => [u.id, u]));
      const listingMap = new Map(listingRows.map((l) => [l.id, l]));

      const responses = respRows.map((r) => ({
        id: r.id,
        uuid: r.uuid,
        item_request_id: r.itemRequestId,
        price: num(r.price),
        message: r.message,
        images: (r.images as string[] | null) ?? [],
        status: r.status,
        created_at: r.createdAt ? new Date(r.createdAt).toISOString() : null,
        updated_at: r.updatedAt ? new Date(r.updatedAt).toISOString() : null,
        store: storeMap.get(r.storeId) ?? { id: r.storeId },
        user: userMap.get(r.userId) ?? { id: r.userId },
        listing: r.listingId ? listingMap.get(r.listingId) ?? null : null,
      }));

      return ok(serializeItemRequest(req, rel, responses));
    },
    { params: t.Object({ id: t.String() }) },
  )

  // 6. PATCH /item-requests/:id/status — mark fulfilled / cancelled
  .patch(
    "/item-requests/:id/status",
    async ({ params, body, currentUser, set }) => {
      if (!currentUser) {
        set.status = 401;
        return fail("Unauthenticated.");
      }

      const isParamUuid = isUuid(params.id);
      const isParamId = /^\d+$/.test(params.id);

      const where = isParamUuid
        ? eq(itemRequests.uuid, params.id)
        : isParamId
          ? eq(itemRequests.id, Number(params.id))
          : null;

      if (!where) {
        set.status = 404;
        return fail("Item request not found.");
      }

      const rows = await db.select().from(itemRequests).where(where).limit(1);
      const req = rows[0];
      if (!req) {
        set.status = 404;
        return fail("Item request not found.");
      }

      if (req.userId !== currentUser.id) {
        set.status = 403;
        return fail("Unauthorized.");
      }

      await db
        .update(itemRequests)
        .set({ status: body.status })
        .where(eq(itemRequests.id, req.id));

      const updated = (await db.select().from(itemRequests).where(eq(itemRequests.id, req.id)).limit(1))[0]!;
      const rel = await loadRequestRelations([updated]);

      return ok(serializeItemRequest(updated, rel), "Item request status updated.");
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Object({
        status: t.Union([t.Literal("fulfilled"), t.Literal("cancelled")]),
      }),
    },
  )

  // 7. POST /item-requests/:id/responses — seller submits an offer
  .post(
    "/item-requests/:id/responses",
    async ({ params, body, currentUser, set }) => {
      if (!currentUser) {
        set.status = 401;
        return fail("Unauthenticated.");
      }

      const isParamUuid = isUuid(params.id);
      const isParamId = /^\d+$/.test(params.id);

      const where = isParamUuid
        ? eq(itemRequests.uuid, params.id)
        : isParamId
          ? eq(itemRequests.id, Number(params.id))
          : null;

      if (!where) {
        set.status = 404;
        return fail("Item request not found.");
      }

      const rows = await db.select().from(itemRequests).where(where).limit(1);
      const req = rows[0];
      if (!req) {
        set.status = 404;
        return fail("Item request not found.");
      }

      if (req.status !== "open") {
        set.status = 422;
        return fail("This item request is no longer open.");
      }

      // Check seller store
      const sellerStores = await db
        .select()
        .from(stores)
        .where(
          and(
            eq(stores.userId, currentUser.id),
            or(eq(stores.status, "active"), eq(stores.status, "approved")),
          ),
        )
        .limit(1);

      const store = sellerStores[0];
      if (!store) {
        set.status = 403;
        return fail("You must have an approved store to respond to item requests.");
      }

      // Check duplicate response
      const existing = await db
        .select({ id: itemRequestResponses.id })
        .from(itemRequestResponses)
        .where(
          and(
            eq(itemRequestResponses.itemRequestId, req.id),
            eq(itemRequestResponses.storeId, store.id),
          ),
        )
        .limit(1);

      if (existing[0]) {
        set.status = 409;
        return fail("You have already responded to this item request.");
      }

      let resolvedListingId: number | null = null;
      if (body.listing_id) {
        if (typeof body.listing_id === "number") {
          resolvedListingId = body.listing_id;
        } else if (isUuid(body.listing_id)) {
          const lRows = await db
            .select({ id: listings.id })
            .from(listings)
            .where(eq(listings.uuid, body.listing_id))
            .limit(1);
          resolvedListingId = lRows[0]?.id ?? null;
        } else if (/^\d+$/.test(body.listing_id)) {
          resolvedListingId = Number(body.listing_id);
        }
      }

      const inserted = await db
        .insert(itemRequestResponses)
        .values({
          itemRequestId: req.id,
          storeId: store.id,
          userId: currentUser.id,
          price: String(body.price),
          message: body.message,
          listingId: resolvedListingId,
          images: body.images ?? [],
          status: "pending",
        })
        .returning();

      const responseRow = inserted[0];
      if (!responseRow) {
        set.status = 500;
        return fail("Failed to submit response.");
      }

      // Increment responses_count on item_requests
      await db
        .update(itemRequests)
        .set({ responsesCount: sql`${itemRequests.responsesCount} + 1` })
        .where(eq(itemRequests.id, req.id));

      // Notify the buyer
      notificationStore.create({
        userId: String(req.userId),
        type: "item_request_response",
        title: `💬 ${store.name} sent you an offer!`,
        body: `₦${Number(body.price).toLocaleString()} for "${req.title}". Tap to view and chat.`,
        data: {
          request_uuid: req.uuid,
          response_uuid: responseRow.uuid,
          store_name: store.name,
          store_uuid: store.uuid,
          price: body.price,
          url: `/item-requests/${req.uuid}?offer=${responseRow.uuid}`,
        },
      });

      set.status = 201;
      return created(
        {
          id: responseRow.id,
          uuid: responseRow.uuid,
          item_request_id: responseRow.itemRequestId,
          price: num(responseRow.price),
          message: responseRow.message,
          images: (responseRow.images as string[] | null) ?? [],
          status: responseRow.status,
          created_at: responseRow.createdAt ? new Date(responseRow.createdAt).toISOString() : null,
          updated_at: responseRow.updatedAt ? new Date(responseRow.updatedAt).toISOString() : null,
          store: {
            id: store.id,
            uuid: store.uuid,
            name: store.name,
            slug: store.slug,
            logo_url: store.logoPath,
            is_verified: store.isVerified,
            rating: num(store.rating),
            is_promoted: store.isPromoted,
          },
          user: {
            id: currentUser.id,
            name: currentUser.name,
          },
          listing: resolvedListingId ? { id: resolvedListingId } : null,
        },
        "Your offer has been submitted and the buyer has been notified.",
      );
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Object({
        price: t.Number({ minimum: 0 }),
        message: t.String({ maxLength: 2000 }),
        listing_id: t.Optional(t.Union([t.String(), t.Number()])),
        images: t.Optional(t.Array(t.String({ maxLength: 500 }))),
      }),
    },
  );

export default itemRequestsModule;
