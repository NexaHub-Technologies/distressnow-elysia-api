/**
 * Reviews module.
 *
 * - GET  /reviews?target_type=store|provider|listing|seller|user&target_id=<id>
 *        (Laravel aliases reviewable_type/reviewable_id and type/id also
 *        accepted). Public. Includes an average/total summary in meta.
 * - POST /reviews { target_type, target_id, rating 1-5, comment? }
 *        (auth; duplicate per user+target -> 409; aggregates updated for
 *        stores/providers; review_received notification sent).
 */
import { Elysia, t } from "elysia";
import { and, count, desc, eq, or, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { listings, reviews, serviceProviders, stores, users } from "../../db/schema";
import { auth } from "../../plugins/auth";
import { fail, ok, paginated } from "../../utils/response";
import { buildMeta, parsePagination } from "../../utils/pagination";
import {
  num,
  validateRating,
  type ReviewTarget,
} from "../../utils/marketplace";
import { notificationStore } from "../notifications/index";

export const EXTENDED_REVIEW_TARGETS = [
  "store",
  "provider",
  "listing",
  "seller",
  "user",
] as const;

export function isValidReviewTarget(value: unknown): boolean {
  return (
    typeof value === "string" &&
    (EXTENDED_REVIEW_TARGETS as readonly string[]).includes(
      value.toLowerCase().trim(),
    )
  );
}

// Re-exported so tests (and clients) can reach the rule via this module.
export { validateRating };

interface ReviewTargetRow {
  kind: "store" | "provider" | "listing" | "user";
  id: number;
  uuid: string;
  ownerId: number;
}

async function resolveTarget(
  targetTypeRaw: string,
  targetId: string,
): Promise<ReviewTargetRow | null> {
  const type = targetTypeRaw.toLowerCase().trim();
  const id = targetId.trim();
  const isNumeric = /^\d+$/.test(id);
  const isUuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

  if (type === "store") {
    let store: typeof stores.$inferSelect | undefined;
    if (isUuid) {
      const rows = await db
        .select()
        .from(stores)
        .where(eq(stores.uuid, id))
        .limit(1);
      store = rows[0];
    } else if (isNumeric) {
      const intId = Number(id);
      const rows = await db
        .select()
        .from(stores)
        .where(or(eq(stores.id, intId), eq(stores.userId, intId)))
        .limit(1);
      store = rows[0];
    } else {
      const rows = await db
        .select()
        .from(stores)
        .where(eq(stores.slug, id))
        .limit(1);
      store = rows[0];
    }
    return store
      ? { kind: "store", id: store.id, uuid: store.uuid, ownerId: store.userId }
      : null;
  }

  if (type === "provider") {
    let provider: typeof serviceProviders.$inferSelect | undefined;
    if (isUuid) {
      const rows = await db
        .select()
        .from(serviceProviders)
        .where(eq(serviceProviders.uuid, id))
        .limit(1);
      provider = rows[0];
    } else if (isNumeric) {
      const intId = Number(id);
      const rows = await db
        .select()
        .from(serviceProviders)
        .where(
          or(eq(serviceProviders.id, intId), eq(serviceProviders.userId, intId)),
        )
        .limit(1);
      provider = rows[0];
    } else {
      const rows = await db
        .select()
        .from(serviceProviders)
        .where(eq(serviceProviders.slug, id))
        .limit(1);
      provider = rows[0];
    }
    return provider
      ? {
          kind: "provider",
          id: provider.id,
          uuid: provider.uuid,
          ownerId: provider.userId,
        }
      : null;
  }

  if (type === "listing") {
    let listing: typeof listings.$inferSelect | undefined;
    if (isUuid) {
      const rows = await db
        .select()
        .from(listings)
        .where(eq(listings.uuid, id))
        .limit(1);
      listing = rows[0];
    } else if (isNumeric) {
      const rows = await db
        .select()
        .from(listings)
        .where(eq(listings.id, Number(id)))
        .limit(1);
      listing = rows[0];
    }
    return listing
      ? {
          kind: "listing",
          id: listing.id,
          uuid: listing.uuid,
          ownerId: listing.userId,
        }
      : null;
  }

  if (type === "seller" || type === "user") {
    let user: typeof users.$inferSelect | undefined;
    if (isNumeric) {
      const rows = await db
        .select()
        .from(users)
        .where(eq(users.id, Number(id)))
        .limit(1);
      user = rows[0];
    } else if (id.includes("@")) {
      const rows = await db
        .select()
        .from(users)
        .where(eq(users.email, id))
        .limit(1);
      user = rows[0];
    }
    return user
      ? { kind: "user", id: user.id, uuid: String(user.id), ownerId: user.id }
      : null;
  }

  return null;
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
      if (!targetTypeRaw || !targetId || !isValidReviewTarget(targetTypeRaw)) {
        set.status = 422;
        return fail(
          "target_type (store|provider|listing|seller|user) and target_id are required.",
        );
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
        db
          .select()
          .from(reviews)
          .where(where)
          .orderBy(desc(reviews.createdAt))
          .limit(perPage)
          .offset(offset),
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
      const rawBody = body as Record<string, any>;
      const targetTypeRaw = (
        rawBody.target_type ??
        rawBody.reviewable_type ??
        rawBody.type ??
        ""
      )
        .toLowerCase()
        .trim();
      const targetId = String(
        rawBody.target_id ?? rawBody.reviewable_id ?? rawBody.id ?? "",
      ).trim();

      if (!targetTypeRaw || !targetId || !isValidReviewTarget(targetTypeRaw)) {
        set.status = 422;
        return fail("target_type must be store, provider, listing, seller or user.");
      }
      const rating = Number(rawBody.rating);
      if (!validateRating(rating)) {
        set.status = 422;
        return fail("Rating must be an integer between 1 and 5.");
      }
      const target = await resolveTarget(targetTypeRaw, targetId);
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
        return fail(`You have already reviewed this ${targetTypeRaw}.`);
      }
      const inserted = await db
        .insert(reviews)
        .values({
          userId: currentUser.id,
          reviewableType: target.kind,
          reviewableId: target.id,
          rating,
          comment: rawBody.comment ?? null,
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
      if (target.ownerId && target.ownerId !== currentUser.id) {
        notificationStore.create({
          userId: String(target.ownerId),
          type: "review_received",
          title: "New review received",
          body: `${currentUser.name} left you a ${rating}-star review.`,
          data: {
            review_id: review.id,
            reviewable_type: targetTypeRaw,
            reviewable_uuid: target.uuid,
            rating,
          },
        });
      }
      set.status = 201;
      return ok(review, "Review submitted successfully.");
    },
    {
      body: t.Object({
        target_type: t.Optional(t.String()),
        target_id: t.Optional(t.String()),
        reviewable_type: t.Optional(t.String()),
        reviewable_id: t.Optional(t.String()),
        type: t.Optional(t.String()),
        id: t.Optional(t.String()),
        booking_id: t.Optional(t.Union([t.String(), t.Number()])),
        rating: t.Integer(),
        comment: t.Optional(t.String({ maxLength: 2000 })),
      }),
    },
  );

export default reviewsModule;
