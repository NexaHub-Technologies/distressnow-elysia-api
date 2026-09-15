/**
 * Marketplace unit tests (bun:test). DB-free: they cover the pure filter
 * query builder, pagination envelope, slug generation, rating validation,
 * deal/promotion rules and route registration order.
 */
import { describe, expect, test } from "bun:test";
import {
  normalizeListingFilters,
  listingsModule,
} from "../src/modules/listings/index";
import { validateRating } from "../src/modules/reviews/index";
import {
  buildPagination,
  distressDiscountOk,
  isReviewTarget,
  isUuid,
  normalizeDealType,
  num,
  pageMeta,
  promotionExpiry,
  promotionWindow,
  slugify,
  toPositiveInt,
  validateRating as validateRatingDirect,
} from "../src/utils/marketplace";

describe("normalizeListingFilters (filter query builder)", () => {
  test("defaults: newest sort, page 1, per_page 20, no distress", () => {
    expect(normalizeListingFilters({})).toMatchObject({
      sort: "newest",
      page: 1,
      perPage: 20,
      distressOnly: false,
    });
  });

  test("parses string page/per_page and price bounds", () => {
    const filters = normalizeListingFilters({
      page: "3",
      per_page: "15",
      min_price: "1000",
      max_price: "50000",
    });
    expect(filters.page).toBe(3);
    expect(filters.perPage).toBe(15);
    expect(filters.minPrice).toBe(1000);
    expect(filters.maxPrice).toBe(50000);
  });

  test("falls back for garbage pagination input", () => {
    const filters = normalizeListingFilters({ page: "abc", per_page: "-5" });
    expect(filters.page).toBe(1);
    expect(filters.perPage).toBe(20);
  });

  test("caps per_page at 100", () => {
    expect(normalizeListingFilters({ per_page: "500" }).perPage).toBe(100);
  });

  test("accepts aliases: category_id, state_id, dealType, minPrice", () => {
    const filters = normalizeListingFilters({
      category_id: "phones",
      state_id: "lagos",
      dealType: "distress",
      minPrice: 200,
    });
    expect(filters.category).toBe("phones");
    expect(filters.state).toBe("lagos");
    expect(filters.dealType).toBe("distress");
    expect(filters.minPrice).toBe(200);
  });

  test("distress flag accepts true/1/\"true\"/\"1\"", () => {
    for (const distress of [true, 1, "true", "1"]) {
      expect(normalizeListingFilters({ distress }).distressOnly).toBe(true);
    }
    expect(normalizeListingFilters({ distress: "false" }).distressOnly).toBe(false);
    expect(normalizeListingFilters({ is_distressed: "1" }).distressOnly).toBe(true);
  });

  test("allowlisted sorts; unknown sort falls back to newest", () => {
    expect(normalizeListingFilters({ sort: "price_low" }).sort).toBe("price_low");
    expect(normalizeListingFilters({ sort: "price_high" }).sort).toBe("price_high");
    expect(normalizeListingFilters({ sort: "popular" }).sort).toBe("popular");
    expect(normalizeListingFilters({ sort: "random" }).sort).toBe("newest");
  });

  test("blank strings become undefined (no filter)", () => {
    const filters = normalizeListingFilters({ q: "   ", condition: "" });
    expect(filters.q).toBeUndefined();
    expect(filters.condition).toBeUndefined();
  });

  test("trims the search query", () => {
    expect(normalizeListingFilters({ q: "  iphone  " }).q).toBe("iphone");
  });
});

describe("pagination envelope", () => {
  test("buildPagination computes limit/offset", () => {
    expect(buildPagination("2", "10")).toEqual({ page: 2, perPage: 10, limit: 10, offset: 10 });
    expect(buildPagination(undefined, undefined)).toMatchObject({ page: 1, perPage: 20, offset: 0 });
  });

  test("pageMeta computes last_page with ceil, minimum 1", () => {
    expect(pageMeta(1, 20, 95)).toEqual({ page: 1, per_page: 20, total: 95, last_page: 5 });
    expect(pageMeta(1, 20, 0)).toEqual({ page: 1, per_page: 20, total: 0, last_page: 1 });
    expect(pageMeta(2, 20, 20)).toEqual({ page: 2, per_page: 20, total: 20, last_page: 1 });
  });

  test("toPositiveInt guards junk", () => {
    expect(toPositiveInt("7", 1)).toBe(7);
    expect(toPositiveInt("0", 1)).toBe(1);
    expect(toPositiveInt(2.5, 1)).toBe(1);
    expect(toPositiveInt(undefined, 4)).toBe(4);
  });
});

describe("slugify", () => {
  test("basic slug generation", () => {
    expect(slugify("iPhone 12 Pro!!")).toBe("iphone-12-pro");
    expect(slugify("  Lagos  Main   Market ")).toBe("lagos-main-market");
    expect(slugify("Café & Bar — 50% Off")).toBe("cafe-bar-50-off");
  });
});

describe("rating validation", () => {
  test("accepts integers 1-5 only", () => {
    for (const rating of [1, 2, 3, 4, 5]) {
      expect(validateRating(rating)).toBe(true);
      expect(validateRatingDirect(rating)).toBe(true);
    }
  });

  test("rejects out-of-range, fractional and non-numeric input", () => {
    for (const rating of [0, 6, -1, 2.5, "5", null, undefined, {}, NaN]) {
      expect(validateRating(rating)).toBe(false);
    }
  });

  test("review targets", () => {
    expect(isReviewTarget("store")).toBe(true);
    expect(isReviewTarget("provider")).toBe(true);
    expect(isReviewTarget("listing")).toBe(true);
    expect(isReviewTarget("user")).toBe(false);
    expect(isReviewTarget(undefined)).toBe(false);
  });
});

describe("deal + promotion rules", () => {
  test("normalizeDealType", () => {
    expect(normalizeDealType("distress")).toBe("distress");
    expect(normalizeDealType("Distress Sale")).toBe("distress");
    expect(normalizeDealType("deal_of_day")).toBe("deal_of_day");
    expect(normalizeDealType("Deal of the Day")).toBe("deal_of_day");
    expect(normalizeDealType("standard")).toBe("standard");
    expect(normalizeDealType(undefined)).toBe("standard");
    expect(normalizeDealType("mystery")).toBe("standard");
  });

  test("distressDiscountOk enforces >= 20% off", () => {
    expect(distressDiscountOk(100, 80)).toBe(true); // exactly 20%
    expect(distressDiscountOk(100, 70)).toBe(true);
    expect(distressDiscountOk(100, 81)).toBe(false); // 19%
    expect(distressDiscountOk(100, 100)).toBe(false);
    expect(distressDiscountOk(100, null)).toBe(true); // no discount set
    expect(distressDiscountOk(100, undefined)).toBe(true);
    expect(distressDiscountOk(0, 0)).toBe(false);
  });

  test("promotionWindow resolves tiers", () => {
    expect(promotionWindow("bump_5_days")).toEqual({ days: 5, featured: false });
    expect(promotionWindow("top_featured_7_days")).toEqual({ days: 7, featured: true });
    expect(promotionWindow("top_15_days")).toEqual({ days: 15, featured: false });
    expect(promotionWindow("top_featured_20_days")).toEqual({ days: 20, featured: true });
    expect(promotionWindow("free")).toBeNull();
    expect(promotionWindow(undefined)).toBeNull();
  });

  test("promotionExpiry adds tier days to the base date", () => {
    const from = new Date("2026-01-01T00:00:00Z");
    const expiry = promotionExpiry("bump_5_days", from);
    expect(expiry?.toISOString()).toBe("2026-01-06T00:00:00.000Z");
    expect(promotionExpiry("nope", from)).toBeNull();
  });
});

describe("misc helpers", () => {
  test("num coerces drizzle numerics", () => {
    expect(num("12.50")).toBe(12.5);
    expect(num(3)).toBe(3);
    expect(num(null)).toBe(0);
    expect(num("junk", 9)).toBe(9);
  });

  test("isUuid", () => {
    expect(isUuid("123e4567-e89b-12d3-a456-426614174000")).toBe(true);
    expect(isUuid("deals")).toBe(false);
    expect(isUuid(123)).toBe(false);
  });
});

describe("listings route registration", () => {
  test("/listings/deals is registered before /listings/:id", () => {
    const paths = listingsModule.routes.map((r) => `${r.method} ${r.path}`);
    const deals = paths.indexOf("GET /listings/deals");
    const byId = paths.indexOf("GET /listings/:id");
    expect(deals).toBeGreaterThanOrEqual(0);
    expect(byId).toBeGreaterThanOrEqual(0);
    expect(deals).toBeLessThan(byId);
  });

  test("all expected listing routes exist", () => {
    const paths = new Set(listingsModule.routes.map((r) => `${r.method} ${r.path}`));
    for (const expected of [
      "GET /listings",
      "GET /listings/deals",
      "GET /listings/:id",
      "GET /user/listings",
      "POST /listings",
      "PUT /listings/:id",
      "DELETE /listings/:id",
      "POST /listings/:id/images",
      "POST /listings/:id/promote",
      "POST /listings/:id/click",
      "POST /listings/:id/view",
      "POST /listings/:id/favorite",
      "GET /user/favorites",
      "POST /listings/:id/recently-viewed",
      "GET /user/recently-viewed",
    ]) {
      expect(paths.has(expected)).toBe(true);
    }
  });
});
