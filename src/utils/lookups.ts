/**
 * Async reference resolvers: turn a user-supplied category/state/market/
 * sublocation reference (UUID, slug or name) into the integer PK the
 * canonical schema uses for FKs.
 *
 * Return convention:
 * - `undefined` -> no filter was supplied, apply no condition.
 * - `null`      -> supplied but unresolvable, caller should return empty.
 * - `number`    -> resolved row id.
 */
import { eq, ilike } from "drizzle-orm";
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";
import { db } from "../db/client";
import {
  categories,
  markets,
  states,
  subcategories,
  sublocations,
} from "../db/schema";
import { isUuid } from "./marketplace";

type RefTable = PgTable & {
  id: AnyPgColumn;
  uuid: AnyPgColumn;
  slug: AnyPgColumn;
  name: AnyPgColumn;
};

async function resolveRef(table: RefTable, ref: string): Promise<number | null> {
  if (isUuid(ref)) {
    const rows = await db
      .select({ id: table.id })
      .from(table)
      .where(eq(table.uuid, ref))
      .limit(1);
    const hit = rows[0]?.id;
    return typeof hit === "number" ? hit : null;
  }
  const slugRows = await db
    .select({ id: table.id })
    .from(table)
    .where(eq(table.slug, ref))
    .limit(1);
  const slugHit = slugRows[0]?.id;
  if (typeof slugHit === "number") return slugHit;
  const nameRows = await db
    .select({ id: table.id })
    .from(table)
    .where(ilike(table.name, ref))
    .limit(1);
  const nameHit = nameRows[0]?.id;
  return typeof nameHit === "number" ? nameHit : null;
}

export async function resolveStateId(
  ref: string | undefined,
): Promise<number | null | undefined> {
  if (!ref) return undefined;
  return resolveRef(states, ref);
}

export async function resolveSublocationId(
  ref: string | undefined,
): Promise<number | null | undefined> {
  if (!ref) return undefined;
  return resolveRef(sublocations, ref);
}

export async function resolveMarketId(
  ref: string | undefined,
): Promise<number | null | undefined> {
  if (!ref) return undefined;
  return resolveRef(markets, ref);
}

export interface CategoryScope {
  categoryId?: number;
  subcategoryId?: number;
}

/**
 * A `category` filter may name a category OR a subcategory (the Laravel
 * reference accepts ids/slugs/names for both). Returns the scope to apply,
 * null when the reference matches nothing.
 */
export async function resolveCategoryScope(
  ref: string | undefined,
): Promise<CategoryScope | null | undefined> {
  if (!ref) return undefined;
  const id = await resolveRef(categories, ref);
  if (id !== null) return { categoryId: id };
  const subId = await resolveRef(subcategories, ref);
  if (subId !== null) return { subcategoryId: subId };
  return null;
}

export async function resolveCategoryIdStrict(
  ref: string | undefined,
): Promise<number | null | undefined> {
  if (!ref) return undefined;
  return resolveRef(categories, ref);
}

export const resolveCategoryId = resolveCategoryIdStrict;

export async function resolveSubcategoryId(
  ref: string | undefined,
): Promise<number | null | undefined> {
  if (!ref) return undefined;
  return resolveRef(subcategories, ref);
}

/** Fetch a market row (used to map a market filter onto state/sublocation). */
export async function findMarketById(id: number) {
  const rows = await db.select().from(markets).where(eq(markets.id, id)).limit(1);
  return rows[0] ?? null;
}
