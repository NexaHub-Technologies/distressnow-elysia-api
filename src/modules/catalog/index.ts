/**
 * Catalog module: master data (categories tree, states, markets).
 *
 * - GET /categories              active categories with subcategories tree
 * - GET /locations/states        active states with sublocations + markets
 * - GET /locations/markets       filterable markets (?state_id, ?state,
 *                                ?sublocation, ?q, ?limit)
 *
 * Public identifiers are UUIDs (Laravel route-binding parity).
 */
import { Elysia, t } from "elysia";
import { asc, eq } from "drizzle-orm";
import { db } from "../../db/client";
import {
  categories,
  markets,
  states,
  subcategories,
  sublocations,
} from "../../db/schema";
import { ok } from "../../utils/response";
import { toPositiveInt } from "../../utils/marketplace";

export const catalog = new Elysia()
  .get("/categories", async () => {
    const cats = await db
      .select()
      .from(categories)
      .where(eq(categories.isActive, true))
      .orderBy(asc(categories.sortOrder), asc(categories.name));
    const subs = await db
      .select()
      .from(subcategories)
      .where(eq(subcategories.isActive, true))
      .orderBy(asc(subcategories.sortOrder), asc(subcategories.name));

    const byCategory = new Map<number, typeof subs>();
    for (const sub of subs) {
      const list = byCategory.get(sub.categoryId) ?? [];
      list.push(sub);
      byCategory.set(sub.categoryId, list);
    }

    return ok(
      cats.map((cat) => ({
        id: cat.uuid,
        name: cat.name,
        slug: cat.slug,
        icon: cat.icon,
        sort_order: cat.sortOrder,
        subcategories: (byCategory.get(cat.id) ?? []).map((sub) => ({
          id: sub.uuid,
          name: sub.name,
          slug: sub.slug,
          sort_order: sub.sortOrder,
        })),
      })),
    );
  })
  .get("/locations/states", async () => {
    const allStates = await db
      .select()
      .from(states)
      .where(eq(states.isActive, true))
      .orderBy(asc(states.name));
    const allSublocations = await db
      .select()
      .from(sublocations)
      .where(eq(sublocations.isActive, true))
      .orderBy(asc(sublocations.name));
    const allMarkets = await db
      .select()
      .from(markets)
      .where(eq(markets.isActive, true))
      .orderBy(asc(markets.name));

    const subsByState = new Map<number, typeof allSublocations>();
    for (const sub of allSublocations) {
      const list = subsByState.get(sub.stateId) ?? [];
      list.push(sub);
      subsByState.set(sub.stateId, list);
    }
    const marketsByState = new Map<number, typeof allMarkets>();
    for (const market of allMarkets) {
      const list = marketsByState.get(market.stateId) ?? [];
      list.push(market);
      marketsByState.set(market.stateId, list);
    }

    return ok(
      allStates.map((state) => ({
        id: state.uuid,
        name: state.name,
        slug: state.slug,
        code: state.code,
        sublocations: (subsByState.get(state.id) ?? []).map((sub) => ({
          id: sub.uuid,
          name: sub.name,
          slug: sub.slug,
        })),
        markets: (marketsByState.get(state.id) ?? []).map((market) => ({
          id: market.uuid,
          name: market.name,
          slug: market.slug,
          address: market.address,
        })),
      })),
    );
  })
  .get(
    "/locations/markets",
    async ({ query }) => {
      const limit = Math.min(toPositiveInt(query.limit, 100), 500);

      const allStates = await db.select().from(states);
      const allSublocations = await db.select().from(sublocations);

      let rows = await db
        .select()
        .from(markets)
        .where(eq(markets.isActive, true))
        .orderBy(asc(markets.name));

      // ?state_id=<uuid|slug> (primary) plus Laravel-compatible aliases.
      const stateRef = query.state_id ?? query.state;
      if (stateRef) {
        const match =
          allStates.find((s) => s.uuid === stateRef || s.slug === stateRef) ??
          allStates.find(
            (s) =>
              s.name.toLowerCase().includes(stateRef.toLowerCase()) ||
              (s.code ?? "").toUpperCase() === stateRef.toUpperCase(),
          );
        rows = match ? rows.filter((m) => m.stateId === match.id) : [];
      }

      const subRef = query.sublocation;
      if (subRef && rows.length > 0) {
        const match =
          allSublocations.find((s) => s.uuid === subRef || s.slug === subRef) ??
          allSublocations.find((s) =>
            s.name.toLowerCase().includes(subRef.toLowerCase()),
          );
        rows = match ? rows.filter((m) => m.sublocationId === match.id) : [];
      }

      const q = query.q?.trim();
      if (q && rows.length > 0) {
        const needle = q.toLowerCase();
        rows = rows.filter((m) => m.name.toLowerCase().includes(needle));
      }

      const stateById = new Map(allStates.map((s) => [s.id, s]));
      const subById = new Map(allSublocations.map((s) => [s.id, s]));

      return ok(
        rows.slice(0, limit).map((market) => {
          const state = stateById.get(market.stateId);
          const sub = market.sublocationId
            ? subById.get(market.sublocationId)
            : undefined;
          return {
            id: market.uuid,
            name: market.name,
            slug: market.slug,
            address: market.address,
            state: state
              ? { id: state.uuid, name: state.name, slug: state.slug }
              : null,
            sublocation: sub
              ? { id: sub.uuid, name: sub.name, slug: sub.slug }
              : null,
          };
        }),
      );
    },
    {
      query: t.Object({
        state_id: t.Optional(t.String()),
        state: t.Optional(t.String()),
        sublocation: t.Optional(t.String()),
        q: t.Optional(t.String()),
        limit: t.Optional(t.String()),
      }),
    },
  );

export default catalog;
