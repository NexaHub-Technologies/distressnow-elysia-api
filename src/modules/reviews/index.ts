/**
 * Reviews module.
 *
 * - GET  /reviews?target_type=store|provider|listing&target_id=<uuid>
 *        (Laravel aliases reviewable_type/reviewable_id and type/id also
 *        accepted). Public. Includes an average/total summary in meta.
 * - POST /reviews { target_type, target_id, rating 1-5, comment? }
 *        (auth; duplicate per user+target -> 409; aggregates updated for
 *        stores/providers).
 */
import { Elysia, t } from "elysia";
import { and, count, desc, eq, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { listings, reviews, serviceProviders, stores, users } from "../../db/schema";
import { auth } from "../../plugins/auth";
import { fail, ok, paginated } from "../../utils/response";
import { buildMeta, parsePagination } from "../../utils/pagination";
import {
  isReviewTarget,
  num,
  validateRating,
  type ReviewTarget,
} from "../../utils/marketplace";

// Re-exported so tests (and clients) can reach the rule via this module.
export { validateRating };

interface ReviewTargetRow {
  kind: "store" | "provider" | "listing";
  id: number;
  uuid: string;
  ownerId: number;
}

async function resolveTarget(
  targetType: ReviewTarget,
  targetUuid: string,
): Promise<ReviewTargetRow | null> {
  if (targetType === "store") {
    const rows = await db.select().from(stores).where(eq(stores.uuid, targetUuid)).limit(1);
    const store = rows[0];
    return store ? { kind: "store", id: store.id, uuid: store.uuid, ownerId: store.userId } : null;
  }
  if (targetType === "provider") {
    const rows = await db
      .select()
      .from(serviceProviders)
      .where(eq(serviceProviders.uuid, targetUuid))
      .limit(1);
    const provider = rows[0];
    return provider
      ? { kind: "provider", id: provider.id, uuid: provider.uuid, ownerId: provider.userId }
      : null;
  }
  const rows = await db.select().from(listings).where(eq(listings.uuid, targetUuid)).limit(1);
  const listing = rows[0];
  return listing
    ? { kind: "listing", id: listing.id, uuid: listing.uuid, ownerId: listing.userId }
    : null;
}

async function updateAggregateRating(kind: "store" | "provider", id: number) {
  const stats = await db
    .select({ avg: sql<string | null>`AVG(${reviews.rating})`, total: count() })
    .from(reviews)
    .where(and(eq(reviews.reviewableType, kind), eq(reviews.reviewableId, id)));
  const stat = stats[0];
  const average = stat?.avg === null || stat?.avg === undefined ? 0 : num(stat.avg);
  const total = stat?.total ?? 0;
  const rounded = Math.round(average * 100) / 100;
  if (kind === "store") {
    await db
      .update(stores)
      .set({ rating: String(rounded), reviewCount: total })
      .where(eq(stores.id, id));
  } else {
    await db
      .update(serviceProviders)
      .set({ rating: String(rounded), totalReviews: total })
      .where(eq(serviceProviders.id, id));
  }
  return { average_rating: rounded, total_reviews: total };
}

export const reviewsModule = new Elysia()
  .use(auth)
  .get(
    "/reviews",
    async ({ query, set }) => {
      const targetTypeRaw =
        query.target_type ?? query.reviewable_type ?? query.type;
      const targetId = query.target_id ?? query.reviewable_id ?? query.id;
      if (!targetTypeRaw || !targetId || !isReviewTarget(targetTypeRaw)) {
        set.status = 422;
        return fail("target_type (store|provider|listing) and target_id are required.");
      }
      const target = await resolveTarget(targetTypeRaw, targetId);
      if (!target) {
        set.status = 404;
        return fail("Review target not found.");
      }
      const { page, perPage, offset } = parsePagination(query);
      const where = and(
        eq(reviews.reviewableType, target.kind),
        eq(reviews.reviewableId, target.id),
      );
      const [rows, totalRows, summaryRows] = await Promise.all([
        db.select().from(reviews).where(where).orderBy(desc(reviews.createdAt)).limit(perPage).offset(offset),
        db.select({ total: count() }).from(reviews).where(where),
        db
          .select({ avg: sql<string | null>`AVG(${reviews.rating})`, total: count() })
          .from(reviews)
          .where(where),
      ]);
      const reviewerIds = [...new Set(rows.map((r) => r.userId))];
      const reviewerRows = await db.select({ id: users.id, name: users.name }).from(users);
      const wanted = new Set(reviewerIds);
      const reviewers = new Map(
        reviewerRows.filter((u) => wanted.has(u.id)).map((u) => [u.id, u]),
      );
      const summary = summaryRows[0];
      const avg = summary?.avg === null || summary?.avg === undefined ? 0 : num(summary.avg);
      const collection = paginated(
        rows.map((review) => ({
          id: review.uuid,
          target_type: target.kind,
          target_id: target.uuid,
          rating: review.rating,
          comment: review.comment,
          reply: review.reply,
          user: reviewers.get(review.userId) ?? { id: review.userId },
          created_at: review.createdAt,
        })),
        buildMeta(page, perPage, totalRows[0]?.total ?? 0),
      );
      return {
        ...collection,
        meta: {
          ...collection.meta,
          average_rating: Math.round(avg * 100) / 100,
        },
      };
    },
    {
      query: t.Object({
        target_type: t.Optional(t.String()),
        target_id: t.Optional(t.String()),
        reviewable_type: t.Optional(t.String()),
        reviewable_id: t.Optional(t.String()),
        type: t.Optional(t.String()),
        id: t.Optional(t.String()),
        page: t.Optional(t.String()),
        per_page: t.Optional(t.String()),
      }),
    },
  )
  .post(
    "/reviews",
    async ({ body, currentUser, set }) => {
      if (!currentUser) {
        set.status = 401;
        return fail("Unauthenticated.");
      }
      if (!isReviewTarget(body.target_type)) {
        set.status = 422;
        return fail("target_type must be store, provider or listing.");
      }
      if (!validateRating(body.rating)) {
        set.status = 422;
        return fail("Rating must be an integer between 1 and 5.");
      }
      const target = await resolveTarget(body.target_type, body.target_id);
      if (!target) {
        set.status = 404;
        return fail("Review target not found.");
      }
      const existing = await db
        .select({ id: reviews.id })
        .from(reviews)
        .where(
          and(
            eq(reviews.userId, currentUser.id),
            eq(reviews.reviewableType, target.kind),
            eq(reviews.reviewableId, target.id),
          ),
        )
        .limit(1);
      if (existing[0]) {
        set.status = 409;
        return fail(`You have already reviewed this ${target.kind}.`);
      }
      const inserted = await db
        .insert(reviews)
        .values({
          userId: currentUser.id,
          reviewableType: target.kind,
          reviewableId: target.id,
          rating: body.rating,
          comment: body.comment ?? null,
        })
        .returning();
      const review = inserted[0];
      if (!review) {
        set.status = 500;
        return fail("Could not submit review.");
      }
      if (target.kind === "store" || target.kind === "provider") {
        await updateAggregateRating(target.kind, target.id);
      }
      set.status = 201;
      return ok(review, "Review submitted successfully.");
    },
    {
      body: t.Object({
        target_type: t.String(),
        target_id: t.String({ format: "uuid" }),
        rating: t.Integer(),
        comment: t.Optional(t.String({ maxLength: 2000 })),
      }),
    },
  );

export default reviewsModule;
