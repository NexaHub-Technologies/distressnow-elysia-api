/**
 * Service providers module.
 *
 * NOTE: GET /providers/bookings is registered BEFORE GET /providers/:id so
 * the static segment is never swallowed by the wildcard.
 *
 * - GET  /providers                        public directory (filters)
 * - GET  /providers/bookings               provider's incoming bookings (auth)
 * - GET  /providers/:id                    public profile (UUID)
 * - PUT  /providers/:id                    owner updates profile (auth)
 * - POST /providers/:id/bookings           buyer creates a booking (auth)
 * - POST /providers/:id/contact-updates    owner proposes contact changes (auth)
 */
import { Elysia, t } from "elysia";
import { and, count, desc, eq, ilike, or, sql, type SQL } from "drizzle-orm";
import { db } from "../../db/client";
import { bookings, contactUpdates, serviceProviders, states, sublocations } from "../../db/schema";
import { auth } from "../../plugins/auth";
import { created, fail, ok, paginated } from "../../utils/response";
import { buildMeta, parsePagination } from "../../utils/pagination";
import {
  CONTACT_UPDATE_FIELDS,
  findUnknownContactFields,
  num,
} from "../../utils/marketplace";
import { resolveStateId, resolveSublocationId } from "../../utils/lookups";

type ProviderRow = typeof serviceProviders.$inferSelect;

interface ProviderRelations {
  states: Map<number, { uuid: string; name: string; slug: string }>;
  sublocations: Map<number, { uuid: string; name: string; slug: string }>;
}

function serializeProvider(provider: ProviderRow, rel: ProviderRelations) {
  return {
    id: provider.uuid,
    name: provider.name,
    slug: provider.slug,
    bio: provider.bio,
    photo_path: provider.photoPath,
    service_categories: (provider.serviceCategories as string[] | null) ?? [],
    experience_years: provider.experienceYears,
    price_range: provider.priceRange,
    response_time: provider.responseTime,
    availability: provider.availability,
    phone: provider.phone,
    whatsapp: provider.whatsapp,
    location_text: provider.locationText,
    skills: (provider.skills as string[] | null) ?? null,
    is_verified: provider.isVerified,
    rating: num(provider.rating),
    total_reviews: provider.totalReviews,
    completed_jobs: provider.completedJobs,
    state: provider.stateId ? (rel.states.get(provider.stateId) ?? null) : null,
    sublocation: provider.sublocationId
      ? (rel.sublocations.get(provider.sublocationId) ?? null)
      : null,
    created_at: provider.createdAt,
    updated_at: provider.updatedAt,
  };
}

async function loadProviderRelations(rows: ProviderRow[]): Promise<ProviderRelations> {
  const stateIds = [...new Set(rows.map((r) => r.stateId).filter((v): v is number => v !== null))];
  const subIds = [...new Set(rows.map((r) => r.sublocationId).filter((v): v is number => v !== null))];
  const [stateRows, subRows] = await Promise.all([
    db.select({ id: states.id, uuid: states.uuid, name: states.name, slug: states.slug }).from(states),
    db.select({ id: sublocations.id, uuid: sublocations.uuid, name: sublocations.name, slug: sublocations.slug }).from(sublocations),
  ]);
  const wantedStates = new Set(stateIds);
  const wantedSubs = new Set(subIds);
  return {
    states: new Map(stateRows.filter((r) => wantedStates.has(r.id)).map((r) => [r.id, r])),
    sublocations: new Map(subRows.filter((r) => wantedSubs.has(r.id)).map((r) => [r.id, r])),
  };
}

async function findProviderByUuid(uuid: string) {
  const rows = await db
    .select()
    .from(serviceProviders)
    .where(eq(serviceProviders.uuid, uuid))
    .limit(1);
  return rows[0] ?? null;
}

const uuidParams = t.Object({ id: t.String({ format: "uuid" }) });

export const providersModule = new Elysia()
  .use(auth)
  .get(
    "/providers",
    async ({ query }) => {
      const { page, perPage, offset } = parsePagination(query);
      const conditions: (SQL | undefined)[] = [eq(serviceProviders.isVerified, true)];

      if (query.category) {
        conditions.push(
          sql`${serviceProviders.serviceCategories} @> ${JSON.stringify([query.category])}::jsonb`,
        );
      }

      const stateId = await resolveStateId(query.state);
      if (stateId === null) return paginated([], buildMeta(page, perPage, 0));
      if (stateId !== undefined) conditions.push(eq(serviceProviders.stateId, stateId));

      const subId = await resolveSublocationId(query.sublocation);
      if (subId === null) return paginated([], buildMeta(page, perPage, 0));
      if (subId !== undefined) conditions.push(eq(serviceProviders.sublocationId, subId));

      if (query.availability) {
        if (query.availability !== "immediate" && query.availability !== "scheduled") {
          return paginated([], buildMeta(page, perPage, 0));
        }
        conditions.push(eq(serviceProviders.availability, query.availability));
      }

      const q = query.q?.trim();
      if (q) {
        const needle = `%${q}%`;
        conditions.push(
          or(ilike(serviceProviders.name, needle), ilike(serviceProviders.bio, needle)),
        );
      }

      const where = and(...conditions);
      const [rows, totalRows] = await Promise.all([
        db
          .select()
          .from(serviceProviders)
          .where(where)
          .orderBy(desc(serviceProviders.rating), desc(serviceProviders.completedJobs))
          .limit(perPage)
          .offset(offset),
        db.select({ total: count() }).from(serviceProviders).where(where),
      ]);
      const rel = await loadProviderRelations(rows);
      return paginated(
        rows.map((provider) => serializeProvider(provider, rel)),
        buildMeta(page, perPage, totalRows[0]?.total ?? 0),
      );
    },
    {
      query: t.Object({
        q: t.Optional(t.String()),
        category: t.Optional(t.String()),
        state: t.Optional(t.String()),
        sublocation: t.Optional(t.String()),
        availability: t.Optional(t.String()),
        page: t.Optional(t.String()),
        per_page: t.Optional(t.String()),
      }),
    },
  )
  .get(
    "/providers/bookings",
    async ({ currentUser, query, set }) => {
      if (!currentUser) {
        set.status = 401;
        return fail("Unauthenticated.");
      }
      const profiles = await db
        .select()
        .from(serviceProviders)
        .where(eq(serviceProviders.userId, currentUser.id))
        .limit(1);
      const provider = profiles[0];
      if (!provider) {
        set.status = 403;
        return fail("You do not have a service provider profile.");
      }
      const { page, perPage, offset } = parsePagination(query);
      const conditions = [eq(bookings.providerId, provider.id)];
      if (query.status) conditions.push(eq(bookings.status, query.status));
      const where = and(...conditions);
      const [rows, totalRows] = await Promise.all([
        db.select().from(bookings).where(where).orderBy(desc(bookings.createdAt)).limit(perPage).offset(offset),
        db.select({ total: count() }).from(bookings).where(where),
      ]);
      return paginated(rows, buildMeta(page, perPage, totalRows[0]?.total ?? 0));
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
    "/providers/:id",
    async ({ params, set }) => {
      const provider = await findProviderByUuid(params.id);
      if (!provider) {
        set.status = 404;
        return fail("Service provider not found.");
      }
      const rel = await loadProviderRelations([provider]);
      return ok(serializeProvider(provider, rel));
    },
    { params: uuidParams },
  )
  .put(
    "/providers/:id",
    async ({ params, body, currentUser, set }) => {
      if (!currentUser) {
        set.status = 401;
        return fail("Unauthenticated.");
      }
      const provider = await findProviderByUuid(params.id);
      if (!provider) {
        set.status = 404;
        return fail("Service provider not found.");
      }
      if (provider.userId !== currentUser.id) {
        set.status = 403;
        return fail("You are not authorized to update this profile.");
      }
      if (
        body.availability !== undefined &&
        body.availability !== "immediate" &&
        body.availability !== "scheduled"
      ) {
        set.status = 422;
        return fail("Availability must be immediate or scheduled.");
      }
      const updated = await db
        .update(serviceProviders)
        .set({
          ...(body.bio !== undefined ? { bio: body.bio } : {}),
          ...(body.service_categories !== undefined
            ? { serviceCategories: body.service_categories }
            : {}),
          ...(body.experience_years !== undefined
            ? { experienceYears: body.experience_years }
            : {}),
          ...(body.price_range !== undefined ? { priceRange: body.price_range } : {}),
          ...(body.response_time !== undefined ? { responseTime: body.response_time } : {}),
          ...(body.availability !== undefined ? { availability: body.availability } : {}),
          ...(body.phone !== undefined ? { phone: body.phone } : {}),
          ...(body.whatsapp !== undefined ? { whatsapp: body.whatsapp } : {}),
          ...(body.location_text !== undefined ? { locationText: body.location_text } : {}),
          ...(body.skills !== undefined ? { skills: body.skills } : {}),
        })
        .where(eq(serviceProviders.id, provider.id))
        .returning();
      const next = updated[0] ?? provider;
      const rel = await loadProviderRelations([next]);
      return ok(serializeProvider(next, rel));
    },
    {
      params: uuidParams,
      body: t.Object({
        bio: t.Optional(t.Union([t.String({ maxLength: 2000 }), t.Null()])),
        service_categories: t.Optional(t.Array(t.String())),
        experience_years: t.Optional(t.Integer({ minimum: 0 })),
        price_range: t.Optional(t.Union([t.String({ maxLength: 100 }), t.Null()])),
        response_time: t.Optional(t.Union([t.String({ maxLength: 100 }), t.Null()])),
        availability: t.Optional(t.String()),
        phone: t.Optional(t.Union([t.String({ maxLength: 20 }), t.Null()])),
        whatsapp: t.Optional(t.Union([t.String({ maxLength: 20 }), t.Null()])),
        location_text: t.Optional(t.Union([t.String({ maxLength: 255 }), t.Null()])),
        skills: t.Optional(t.Union([t.Array(t.String()), t.Null()])),
      }),
    },
  )
  .post(
    "/providers/:id/bookings",
    async ({ params, body, currentUser, set }) => {
      if (!currentUser) {
        set.status = 401;
        return fail("Unauthenticated.");
      }
      const provider = await findProviderByUuid(params.id);
      if (!provider) {
        set.status = 404;
        return fail("Service provider not found.");
      }
      if (body.preferred_date !== undefined && Number.isNaN(Date.parse(body.preferred_date))) {
        set.status = 422;
        return fail("Preferred date must be a valid date.");
      }
      const inserted = await db
        .insert(bookings)
        .values({
          userId: currentUser.id,
          providerId: provider.id,
          serviceType: body.service_type,
          description: body.description ?? null,
          preferredDate: body.preferred_date ?? null,
          preferredTime: body.preferred_time ?? null,
          locationText: body.location_text ?? null,
          latitude: body.latitude !== undefined ? String(body.latitude) : null,
          longitude: body.longitude !== undefined ? String(body.longitude) : null,
          status: "pending",
        })
        .returning();
      const booking = inserted[0];
      if (!booking) {
        set.status = 500;
        return fail("Could not create booking.");
      }
      set.status = 201;
      return created(booking, "Booking request submitted successfully.");
    },
    {
      params: uuidParams,
      body: t.Object({
        service_type: t.String({ minLength: 1, maxLength: 255 }),
        description: t.Optional(t.String({ maxLength: 2000 })),
        preferred_date: t.Optional(t.String()),
        preferred_time: t.Optional(t.String({ maxLength: 50 })),
        location_text: t.Optional(t.String({ maxLength: 500 })),
        latitude: t.Optional(t.Number({ minimum: -90, maximum: 90 })),
        longitude: t.Optional(t.Number({ minimum: -180, maximum: 180 })),
      }),
    },
  )
  .post(
    "/providers/:id/contact-updates",
    async ({ params, body, currentUser, set }) => {
      if (!currentUser) {
        set.status = 401;
        return fail("Unauthenticated.");
      }
      const provider = await findProviderByUuid(params.id);
      if (!provider) {
        set.status = 404;
        return fail("Service provider not found.");
      }
      if (provider.userId !== currentUser.id) {
        set.status = 403;
        return fail("You are not authorized to request changes for this profile.");
      }
      const changes = (body.proposed_changes ?? {}) as Record<string, unknown>;
      if (Object.keys(changes).length === 0) {
        set.status = 422;
        return fail("Proposed changes must not be empty.");
      }
      const unknown = findUnknownContactFields(changes);
      if (unknown.length > 0) {
        set.status = 422;
        return fail(`Invalid contact fields: ${unknown.join(", ")}.`);
      }
      const inserted = await db
        .insert(contactUpdates)
        .values({
          providerId: provider.id,
          requestedBy: currentUser.id,
          proposedChanges: changes,
          status: "pending",
        })
        .returning();
      set.status = 201;
      return created(inserted[0] ?? null, "Contact update submitted for review.");
    },
    {
      params: uuidParams,
      body: t.Object({
        proposed_changes: t.Record(t.String(), t.Unknown()),
      }),
    },
  );

export { CONTACT_UPDATE_FIELDS };
export default providersModule;
