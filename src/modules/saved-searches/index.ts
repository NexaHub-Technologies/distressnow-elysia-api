/**
 * Saved searches module.
 *
 * - GET    /user/saved-searches       list own saved searches (auth)
 * - POST   /user/saved-searches       save { name, filters } (auth)
 * - DELETE /user/saved-searches/:id   delete own saved search (auth)
 *
 * NOTE: saved_searches rows use integer PKs (no uuid column), so `:id`
 * here is the numeric id.
 */
import { Elysia, t } from "elysia";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../../db/client";
import { savedSearches } from "../../db/schema";
import { auth } from "../../plugins/auth";
import { fail, ok } from "../../utils/response";

export const savedSearchesModule = new Elysia()
  .use(auth)
  .get("/user/saved-searches", async ({ currentUser, set }) => {
    if (!currentUser) {
      set.status = 401;
      return fail("Unauthenticated.");
    }
    const rows = await db
      .select({
        id: savedSearches.id,
        name: savedSearches.name,
        filters: savedSearches.filters,
        createdAt: savedSearches.createdAt,
      })
      .from(savedSearches)
      .where(eq(savedSearches.userId, currentUser.id))
      .orderBy(desc(savedSearches.createdAt));
    return ok(rows);
  })
  .post(
    "/user/saved-searches",
    async ({ body, currentUser, set }) => {
      if (!currentUser) {
        set.status = 401;
        return fail("Unauthenticated.");
      }
      if (body.name.trim() === "") {
        set.status = 422;
        return fail("Name is required.");
      }
      const inserted = await db
        .insert(savedSearches)
        .values({ userId: currentUser.id, name: body.name.trim(), filters: body.filters })
        .returning();
      set.status = 201;
      return ok(inserted[0] ?? null, "Saved search created.");
    },
    {
      body: t.Object({
        name: t.String({ minLength: 1, maxLength: 120 }),
        filters: t.Record(t.String(), t.Unknown()),
      }),
    },
  )
  .delete(
    "/user/saved-searches/:id",
    async ({ params, currentUser, set }) => {
      if (!currentUser) {
        set.status = 401;
        return fail("Unauthenticated.");
      }
      const id = Number(params.id);
      if (!Number.isInteger(id) || id <= 0) {
        set.status = 404;
        return fail("Saved search not found.");
      }
      const rows = await db
        .select()
        .from(savedSearches)
        .where(and(eq(savedSearches.id, id), eq(savedSearches.userId, currentUser.id)))
        .limit(1);
      const saved = rows[0];
      if (!saved) {
        set.status = 404;
        return fail("Saved search not found.");
      }
      await db.delete(savedSearches).where(eq(savedSearches.id, saved.id));
      return ok(null, "Saved search deleted.");
    },
    { params: t.Object({ id: t.String() }) },
  );

export default savedSearchesModule;
