import { Elysia, t } from "elysia";
import { and, count, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "../../db/client";
import {
  profileViews,
  serviceProviders,
  serviceProviderViews,
  users,
} from "../../db/schema";
import { auth } from "../../plugins/auth";
import { fail, ok } from "../../utils/response";
import { buildMeta, parsePagination } from "../../utils/pagination";
import { notificationStore } from "../notifications/index";

async function findProvider(idOrSlug: string) {
  const isNumeric = /^\d+$/.test(idOrSlug);
  const isUuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      idOrSlug,
    );
  if (isUuid) {
    const rows = await db
      .select()
      .from(serviceProviders)
      .where(eq(serviceProviders.uuid, idOrSlug))
      .limit(1);
    return rows[0] ?? null;
  }
  if (isNumeric) {
    const rows = await db
      .select()
      .from(serviceProviders)
      .where(eq(serviceProviders.id, Number(idOrSlug)))
      .limit(1);
    return rows[0] ?? null;
  }
  const rows = await db
    .select()
    .from(serviceProviders)
    .where(eq(serviceProviders.slug, idOrSlug))
    .limit(1);
  return rows[0] ?? null;
}

export const viewTrackingModule = new Elysia()
  .use(auth)
  .post(
    "/users/:id/view",
    async ({ params, currentUser, request, set }) => {
      const targetUserId = Number(params.id);
      if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
        set.status = 404;
        return fail("User not found.");
      }

      const targetUserRows = await db
        .select({
          id: users.id,
          name: users.name,
          profileViewsCount: users.profileViewsCount,
        })
        .from(users)
        .where(eq(users.id, targetUserId))
        .limit(1);

      const targetUser = targetUserRows[0];
      if (!targetUser) {
        set.status = 404;
        return fail("User not found.");
      }

      const ip =
        request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "127.0.0.1";
      const userAgent = request.headers.get("user-agent") || "";
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);

      const recent = await db
        .select({ id: profileViews.id })
        .from(profileViews)
        .where(
          and(
            eq(profileViews.userId, targetUserId),
            currentUser
              ? eq(profileViews.viewerId, currentUser.id)
              : eq(profileViews.ipAddress, ip),
            gte(profileViews.viewedAt, fiveMinutesAgo),
          ),
        )
        .limit(1);

      let currentViews = targetUser.profileViewsCount
        ? Number(targetUser.profileViewsCount)
        : 0;

      if (!recent[0]) {
        await db.insert(profileViews).values({
          userId: targetUserId,
          viewerId: currentUser ? currentUser.id : null,
          ipAddress: ip,
          userAgent,
          viewedAt: new Date(),
        });

        const updated = await db
          .update(users)
          .set({ profileViewsCount: sql`${users.profileViewsCount} + 1` })
          .where(eq(users.id, targetUserId))
          .returning({ profileViewsCount: users.profileViewsCount });

        currentViews = updated[0]?.profileViewsCount
          ? Number(updated[0].profileViewsCount)
          : currentViews + 1;

        if (currentUser && targetUserId !== currentUser.id) {
          notificationStore.create({
            userId: String(targetUserId),
            type: "profile_viewed",
            title: "Profile View Notice",
            body: `${currentUser.name} viewed your profile.`,
            data: {
              profile_owner_id: targetUserId,
              target_type: "profile",
              target_id: targetUserId,
              target_name: targetUser.name,
              viewer_id: currentUser.id,
              viewer_name: currentUser.name,
              viewer_avatar: (currentUser as any).avatar_url ?? null,
              chat_link: `/chat?recipient_id=${currentUser.id}`,
              profile_url: `/user/${currentUser.id}`,
            },
          });
        }
      }

      return ok(
        { profile_views_count: currentViews, throttled: Boolean(recent[0]) },
        "Profile view recorded",
      );
    },
    { params: t.Object({ id: t.String() }) },
  )
  .get(
    "/user/profile/analytics",
    async ({ currentUser, query, set }) => {
      if (!currentUser) {
        set.status = 401;
        return fail("Unauthenticated.");
      }

      const { page, perPage, offset } = parsePagination(query);
      const where = and(
        eq(profileViews.userId, currentUser.id),
        sql`${profileViews.viewerId} IS NOT NULL`,
      );

      const [viewRows, totalRows] = await Promise.all([
        db
          .select()
          .from(profileViews)
          .where(where)
          .orderBy(desc(profileViews.viewedAt))
          .limit(perPage)
          .offset(offset),
        db.select({ total: count() }).from(profileViews).where(where),
      ]);

      const viewerIds = [
        ...new Set(
          viewRows
            .map((v) => v.viewerId)
            .filter((id): id is number => id !== null),
        ),
      ];
      const viewerRows =
        viewerIds.length > 0
          ? await db
              .select({
                id: users.id,
                name: users.name,
                email: users.email,
                avatarPath: users.avatarPath,
              })
              .from(users)
              .where(inArray(users.id, viewerIds))
          : [];
      const viewerMap = new Map(viewerRows.map((u) => [u.id, u]));

      const recentViewers = viewRows.map((v) => ({
        id: v.id,
        viewer: v.viewerId ? viewerMap.get(v.viewerId) ?? { id: v.viewerId } : null,
        viewed_at: v.viewedAt,
      }));

      return ok({
        profile_views_count: currentUser.profileViewsCount
          ? Number(currentUser.profileViewsCount)
          : 0,
        recent_viewers: recentViewers,
        meta: buildMeta(page, perPage, totalRows[0]?.total ?? 0),
      });
    },
    {
      query: t.Object({
        page: t.Optional(t.Union([t.String(), t.Number()])),
        per_page: t.Optional(t.Union([t.String(), t.Number()])),
      }),
    },
  )
  .post(
    "/providers/:id/view",
    async ({ params, currentUser, request, set }) => {
      const provider = await findProvider(params.id);
      if (!provider) {
        set.status = 404;
        return fail("Service provider not found.");
      }

      const ip =
        request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "127.0.0.1";
      const userAgent = request.headers.get("user-agent") || "";
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);

      const recent = await db
        .select({ id: serviceProviderViews.id })
        .from(serviceProviderViews)
        .where(
          and(
            eq(serviceProviderViews.serviceProviderId, provider.id),
            currentUser
              ? eq(serviceProviderViews.viewerId, currentUser.id)
              : eq(serviceProviderViews.ipAddress, ip),
            gte(serviceProviderViews.viewedAt, fiveMinutesAgo),
          ),
        )
        .limit(1);

      let currentViews = provider.viewsCount ? Number(provider.viewsCount) : 0;

      if (!recent[0]) {
        await db.insert(serviceProviderViews).values({
          serviceProviderId: provider.id,
          viewerId: currentUser ? currentUser.id : null,
          ipAddress: ip,
          userAgent,
          viewedAt: new Date(),
        });

        const updated = await db
          .update(serviceProviders)
          .set({ viewsCount: sql`${serviceProviders.viewsCount} + 1` })
          .where(eq(serviceProviders.id, provider.id))
          .returning({ viewsCount: serviceProviders.viewsCount });

        currentViews = updated[0]?.viewsCount
          ? Number(updated[0].viewsCount)
          : currentViews + 1;

        if (currentUser && provider.userId && provider.userId !== currentUser.id) {
          notificationStore.create({
            userId: String(provider.userId),
            type: "service_viewed",
            title: "Service Page View Notice",
            body: `${currentUser.name} viewed your service '${provider.name}'.`,
            data: {
              service_id: provider.id,
              service_uuid: provider.uuid,
              service_name: provider.name,
              target_type: "service",
              target_id: provider.uuid || provider.id,
              target_name: provider.name,
              viewer_id: currentUser.id,
              viewer_name: currentUser.name,
              viewer_avatar: (currentUser as any).avatar_url ?? null,
              chat_link: `/chat?recipient_id=${currentUser.id}`,
              profile_url: `/user/${currentUser.id}`,
            },
          });
        }
      }

      return ok(
        { views_count: currentViews, throttled: Boolean(recent[0]) },
        "Service provider view recorded",
      );
    },
    { params: t.Object({ id: t.String() }) },
  )
  .get(
    "/user/providers/:id/analytics",
    async ({ params, currentUser, userRoles, query, set }) => {
      if (!currentUser) {
        set.status = 401;
        return fail("Unauthenticated.");
      }

      const provider = await findProvider(params.id);
      if (!provider) {
        set.status = 404;
        return fail("Service provider not found.");
      }

      const isOwner = provider.userId === currentUser.id;
      const isAdmin = userRoles.includes("admin");
      if (!isOwner && !isAdmin) {
        set.status = 403;
        return fail("Unauthorized access to service provider analytics.");
      }

      const { page, perPage, offset } = parsePagination(query);
      const where = and(
        eq(serviceProviderViews.serviceProviderId, provider.id),
        sql`${serviceProviderViews.viewerId} IS NOT NULL`,
      );

      const [viewRows, totalRows] = await Promise.all([
        db
          .select()
          .from(serviceProviderViews)
          .where(where)
          .orderBy(desc(serviceProviderViews.viewedAt))
          .limit(perPage)
          .offset(offset),
        db.select({ total: count() }).from(serviceProviderViews).where(where),
      ]);

      const viewerIds = [
        ...new Set(
          viewRows
            .map((v) => v.viewerId)
            .filter((id): id is number => id !== null),
        ),
      ];
      const viewerRows =
        viewerIds.length > 0
          ? await db
              .select({
                id: users.id,
                name: users.name,
                email: users.email,
                avatarPath: users.avatarPath,
              })
              .from(users)
              .where(inArray(users.id, viewerIds))
          : [];
      const viewerMap = new Map(viewerRows.map((u) => [u.id, u]));

      const recentViewers = viewRows.map((v) => ({
        id: v.id,
        viewer: v.viewerId ? viewerMap.get(v.viewerId) ?? { id: v.viewerId } : null,
        viewed_at: v.viewedAt,
      }));

      return ok({
        provider: {
          id: provider.id,
          uuid: provider.uuid,
          name: provider.name,
          views_count: provider.viewsCount ? Number(provider.viewsCount) : 0,
        },
        recent_viewers: recentViewers,
        meta: buildMeta(page, perPage, totalRows[0]?.total ?? 0),
      });
    },
    {
      params: t.Object({ id: t.String() }),
      query: t.Object({
        page: t.Optional(t.Union([t.String(), t.Number()])),
        per_page: t.Optional(t.Union([t.String(), t.Number()])),
      }),
    },
  );

export default viewTrackingModule;
