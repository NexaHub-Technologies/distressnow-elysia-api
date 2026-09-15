/**
 * Bookings module (buyer + shared detail/status views).
 * Provider-side listing lives in the providers module
 * (GET /providers/bookings) to mirror the Laravel route table.
 *
 * - GET   /bookings               buyer's bookings (auth, ?status)
 * - GET   /bookings/:id           detail, buyer or provider owner only (auth)
 * - PATCH /bookings/:id/status    {accepted|declined|completed|cancelled}
 *                                 with owner/provider authorization (auth)
 *
 * Transitions:
 * - pending   -> accepted | declined   (provider owner only)
 * - accepted  -> completed             (provider owner only)
 * - non-final -> cancelled             (buyer or provider owner)
 *
 * Booking `:id` params are UUIDs.
 */
import { Elysia, t } from "elysia";
import { and, count, desc, eq } from "drizzle-orm";
import { db } from "../../db/client";
import { bookings, serviceProviders, users } from "../../db/schema";
import { auth } from "../../plugins/auth";
import { fail, ok, paginated } from "../../utils/response";
import { buildMeta, parsePagination } from "../../utils/pagination";
import {
  BOOKING_PUBLIC_STATUSES,
  FINAL_BOOKING_STATUSES,
  num,
  type BookingPublicStatus,
} from "../../utils/marketplace";

const uuidParams = t.Object({ id: t.String({ format: "uuid" }) });

type BookingRow = typeof bookings.$inferSelect;

function serializeBooking(
  booking: BookingRow,
  provider: { uuid: string; name: string; slug: string; photoPath: string | null } | null,
  buyer: { id: number; name: string } | null,
) {
  return {
    id: booking.uuid,
    service_type: booking.serviceType,
    description: booking.description,
    preferred_date: booking.preferredDate,
    preferred_time: booking.preferredTime,
    location_text: booking.locationText,
    quoted_price: booking.quotedPrice === null ? null : num(booking.quotedPrice),
    final_price: booking.finalPrice === null ? null : num(booking.finalPrice),
    status: booking.status,
    cancellation_reason: booking.cancellationReason,
    accepted_at: booking.acceptedAt,
    started_at: booking.startedAt,
    completed_at: booking.completedAt,
    cancelled_at: booking.cancelledAt,
    provider,
    user: buyer,
    created_at: booking.createdAt,
    updated_at: booking.updatedAt,
  };
}

async function loadBookingParties(rows: BookingRow[]) {
  const providerIds = [...new Set(rows.map((r) => r.providerId))];
  const userIds = [...new Set(rows.map((r) => r.userId))];
  const [providerRows, userRows] = await Promise.all([
    db.select().from(serviceProviders),
    db.select({ id: users.id, name: users.name }).from(users),
  ]);
  const wantedProviders = new Set(providerIds);
  const wantedUsers = new Set(userIds);
  return {
    providers: new Map(
      providerRows
        .filter((p) => wantedProviders.has(p.id))
        .map((p) => [p.id, { uuid: p.uuid, name: p.name, slug: p.slug, photoPath: p.photoPath }]),
    ),
    users: new Map(userRows.filter((u) => wantedUsers.has(u.id)).map((u) => [u.id, u])),
  };
}

async function findBookingByUuid(uuid: string) {
  const rows = await db.select().from(bookings).where(eq(bookings.uuid, uuid)).limit(1);
  return rows[0] ?? null;
}

async function providerOwnerId(providerId: number): Promise<number | null> {
  const rows = await db
    .select({ userId: serviceProviders.userId })
    .from(serviceProviders)
    .where(eq(serviceProviders.id, providerId))
    .limit(1);
  return rows[0]?.userId ?? null;
}

export const bookingsModule = new Elysia()
  .use(auth)
  .get(
    "/bookings",
    async ({ currentUser, query, set }) => {
      if (!currentUser) {
        set.status = 401;
        return fail("Unauthenticated.");
      }
      const { page, perPage, offset } = parsePagination(query);
      const conditions = [eq(bookings.userId, currentUser.id)];
      if (query.status) conditions.push(eq(bookings.status, query.status));
      const where = and(...conditions);
      const [rows, totalRows] = await Promise.all([
        db.select().from(bookings).where(where).orderBy(desc(bookings.createdAt)).limit(perPage).offset(offset),
        db.select({ total: count() }).from(bookings).where(where),
      ]);
      const parties = await loadBookingParties(rows);
      return paginated(
        rows.map((booking) =>
          serializeBooking(
            booking,
            parties.providers.get(booking.providerId) ?? null,
            parties.users.get(booking.userId) ?? null,
          ),
        ),
        buildMeta(page, perPage, totalRows[0]?.total ?? 0),
      );
    },
    {
      query: t.Object({
        status: t.Optional(t.String()),
        page: t.Optional(t.String()),
        per_page: t.Optional(t.String()),
      }),
    },
  )
  .get(
    "/bookings/:id",
    async ({ params, currentUser, set }) => {
      if (!currentUser) {
        set.status = 401;
        return fail("Unauthenticated.");
      }
      const booking = await findBookingByUuid(params.id);
      if (!booking) {
        set.status = 404;
        return fail("Booking not found.");
      }
      const ownerId = await providerOwnerId(booking.providerId);
      if (booking.userId !== currentUser.id && ownerId !== currentUser.id) {
        set.status = 403;
        return fail("You are not authorized to view this booking.");
      }
      const parties = await loadBookingParties([booking]);
      return ok(
        serializeBooking(
          booking,
          parties.providers.get(booking.providerId) ?? null,
          parties.users.get(booking.userId) ?? null,
        ),
      );
    },
    { params: uuidParams },
  )
  .patch(
    "/bookings/:id/status",
    async ({ params, body, currentUser, set }) => {
      if (!currentUser) {
        set.status = 401;
        return fail("Unauthenticated.");
      }
      const booking = await findBookingByUuid(params.id);
      if (!booking) {
        set.status = 404;
        return fail("Booking not found.");
      }
      const ownerId = await providerOwnerId(booking.providerId);
      const isProvider = ownerId === currentUser.id;
      const isBuyer = booking.userId === currentUser.id;
      if (!isProvider && !isBuyer) {
        set.status = 403;
        return fail("You are not authorized to update this booking.");
      }

      const next: BookingPublicStatus = body.status;
      const now = new Date();

      if (FINAL_BOOKING_STATUSES.has(booking.status)) {
        set.status = 422;
        return fail("Booking is already finalized.");
      }

      if (next === "accepted") {
        if (!isProvider) {
          set.status = 403;
          return fail("Only the provider can accept.");
        }
        if (booking.status !== "pending") {
          set.status = 422;
          return fail("Only pending bookings can be accepted.");
        }
        const updated = await db
          .update(bookings)
          .set({
            status: "accepted",
            acceptedAt: now,
            ...(body.quoted_price !== undefined ? { quotedPrice: String(body.quoted_price) } : {}),
          })
          .where(eq(bookings.id, booking.id))
          .returning();
        return ok(updated[0] ?? booking, "Booking accepted.");
      }

      if (next === "declined") {
        if (!isProvider) {
          set.status = 403;
          return fail("Only the provider can decline.");
        }
        if (booking.status !== "pending") {
          set.status = 422;
          return fail("Only pending bookings can be declined.");
        }
        const updated = await db
          .update(bookings)
          .set({
            status: "declined",
            cancelledAt: now,
            cancellationReason: body.reason ?? null,
          })
          .where(eq(bookings.id, booking.id))
          .returning();
        return ok(updated[0] ?? booking, "Booking declined.");
      }

      if (next === "completed") {
        if (!isProvider) {
          set.status = 403;
          return fail("Only the provider can complete.");
        }
        if (booking.status !== "accepted") {
          set.status = 422;
          return fail("Only accepted bookings can be completed.");
        }
        const updated = await db
          .update(bookings)
          .set({
            status: "completed",
            completedAt: now,
            ...(body.quoted_price !== undefined ? { finalPrice: String(body.quoted_price) } : {}),
          })
          .where(eq(bookings.id, booking.id))
          .returning();
        await db
          .update(serviceProviders)
          .set({
            completedJobs: (await providerCompletedJobs(booking.providerId)) + 1,
          })
          .where(eq(serviceProviders.id, booking.providerId));
        return ok(updated[0] ?? booking, "Booking completed.");
      }

      // next === "cancelled": buyer or provider, any non-final status.
      const updated = await db
        .update(bookings)
        .set({
          status: "cancelled",
          cancelledAt: now,
          cancelledBy: currentUser.id,
          cancellationReason: body.reason ?? null,
        })
        .where(eq(bookings.id, booking.id))
        .returning();
      return ok(updated[0] ?? booking, "Booking cancelled.");
    },
    {
      params: uuidParams,
      body: t.Object({
        status: t.Union([
          ...BOOKING_PUBLIC_STATUSES.map((s) => t.Literal(s)),
        ]),
        reason: t.Optional(t.String({ maxLength: 1000 })),
        quoted_price: t.Optional(t.Number({ minimum: 0 })),
      }),
    },
  );

async function providerCompletedJobs(providerId: number): Promise<number> {
  const rows = await db
    .select({ completedJobs: serviceProviders.completedJobs })
    .from(serviceProviders)
    .where(eq(serviceProviders.id, providerId))
    .limit(1);
  return rows[0]?.completedJobs ?? 0;
}

export default bookingsModule;
