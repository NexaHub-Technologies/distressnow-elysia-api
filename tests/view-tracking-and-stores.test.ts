// tests/view-tracking-and-stores.test.ts
//
// Tests for view tracking, store directory & analytics, promotion packages,
// and store follower management.

import { describe, expect, test, beforeAll } from "bun:test";
import { eq } from "drizzle-orm";
import { app } from "../src/index";
import { db } from "../src/db/client";
import { profileViews, serviceProviders, serviceProviderViews, stores, storeViews } from "../src/db/schema";
import { mintJwtToken } from "../src/modules/auth/index";
import { env } from "../src/env";

const SECRET = env.JWT_SECRET;

function json(method: string, path: string, body?: unknown, headers?: Record<string, string>) {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(headers ?? {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function handle(req: Request) {
  const res = await app.handle(req);
  const data = (await res.json()) as Record<string, unknown>;
  return { status: res.status, data };
}

describe("Stores Directory & Counts", () => {
  test("GET /api/v1/stores/counts returns nationwide counts and state breakdown", async () => {
    const { status, data } = await handle(json("GET", "/api/v1/stores/counts"));
    expect(status).toBe(200);
    expect(data.success).toBe(true);
    const countsData = data.data as Record<string, unknown>;
    expect(countsData.total).toBeDefined();
    expect(Array.isArray(countsData.states)).toBe(true);
  });
});

describe("Store Management, View Tracking & Follows", () => {
  let user1Token: string;
  let user2Token: string;
  let auth1: Record<string, string>;
  let auth2: Record<string, string>;
  let storeUuid: string;
  let storeNumericId: number;

  beforeAll(async () => {
    // User 1 is an admin in seeded DB; User 2 is also in DB
    user1Token = await mintJwtToken(SECRET, "1");
    user2Token = await mintJwtToken(SECRET, "2");
    auth1 = { Authorization: `Bearer ${user1Token}` };
    auth2 = { Authorization: `Bearer ${user2Token}` };

    // Check if user 1 already has a store or create one
    const userStoresRes = await handle(json("GET", "/api/v1/user/stores", undefined, auth1));
    const userStoresList = (userStoresRes.data.data as Array<Record<string, unknown>>) || [];

    if (userStoresList.length > 0) {
      storeUuid = userStoresList[0]?.id as string;
    } else {
      const createRes = await handle(
        json(
          "POST",
          "/api/v1/stores",
          {
            name: `Test Store ${Date.now()}`,
            description: "High quality electronics and accessories",
          },
          auth1,
        ),
      );
      expect(createRes.status).toBe(201);
      const createdStore = createRes.data.data as Record<string, unknown>;
      storeUuid = createdStore.id as string;
    }

    const storeRows = await db.select({ id: stores.id }).from(stores).where(eq(stores.uuid, storeUuid)).limit(1);
    if (storeRows[0]) {
      await db.delete(storeViews).where(eq(storeViews.storeId, storeRows[0].id));
    }
    await db.delete(profileViews).where(eq(profileViews.userId, 1));
  });

  test("GET /api/v1/user/stores returns seller store list with auth", async () => {
    const { status, data } = await handle(json("GET", "/api/v1/user/stores", undefined, auth1));
    expect(status).toBe(200);
    expect(data.success).toBe(true);
    const storeList = data.data as Array<Record<string, unknown>>;
    expect(storeList.length).toBeGreaterThan(0);
    expect(storeList[0]?.name).toBeDefined();
    expect(storeList[0]?.views_count).toBeDefined();
  });

  test("POST /api/v1/stores/:id/view records view and throttles within 5 minutes", async () => {
    // First view
    const view1 = await handle(json("POST", `/api/v1/stores/${storeUuid}/view`, undefined, auth2));
    expect(view1.status).toBe(200);
    expect(view1.data.success).toBe(true);
    const view1Data = view1.data.data as Record<string, unknown>;
    expect(view1Data.throttled).toBe(false);
    expect(typeof view1Data.views_count).toBe("number");

    // Second immediate view from same user -> throttled = true, views_count unchanged
    const view2 = await handle(json("POST", `/api/v1/stores/${storeUuid}/view`, undefined, auth2));
    expect(view2.status).toBe(200);
    const view2Data = view2.data.data as Record<string, unknown>;
    expect(view2Data.throttled).toBe(true);
  });

  test("GET /api/v1/user/stores/:id/analytics returns store views, followers, and viewers", async () => {
    const { status, data } = await handle(
      json("GET", `/api/v1/user/stores/${storeUuid}/analytics`, undefined, auth1),
    );
    expect(status).toBe(200);
    expect(data.success).toBe(true);
    const analytics = data.data as Record<string, unknown>;
    const storeObj = analytics.store as Record<string, unknown>;
    expect(storeObj.id).toBeDefined();
    expect(typeof storeObj.views_count).toBe("number");
    expect(typeof storeObj.followers_count).toBe("number");
    expect(Array.isArray(analytics.recent_viewers)).toBe(true);
  });

  test("POST /api/v1/stores/:id/promote activates promotion with valid package", async () => {
    const { status, data } = await handle(
      json(
        "POST",
        `/api/v1/stores/${storeUuid}/promote`,
        { promotion_package: "store_1_week" },
        auth1,
      ),
    );
    expect(status).toBe(200);
    expect(data.success).toBe(true);
    const promoData = data.data as Record<string, unknown>;
    expect(promoData.is_promoted).toBe(true);
    expect(promoData.promotion_expiry).toBeDefined();
  });

  test("Store follow flow: follow -> check followers -> followed-stores -> unfollow", async () => {
    // 1. User 2 follows User 1's store
    const followRes = await handle(
      json("POST", `/api/v1/stores/${storeUuid}/follow`, undefined, auth2),
    );
    expect([200, 201]).toContain(followRes.status);
    expect(followRes.data.success).toBe(true);

    // 2. Check store followers list
    const followersRes = await handle(
      json("GET", `/api/v1/stores/${storeUuid}/followers`),
    );
    expect(followersRes.status).toBe(200);
    const followers = followersRes.data.data as Array<Record<string, unknown>>;
    expect(followers.length).toBeGreaterThan(0);

    // 3. User 2 checks their followed stores
    const followedRes = await handle(
      json("GET", "/api/v1/user/followed-stores", undefined, auth2),
    );
    expect(followedRes.status).toBe(200);
    const followedList = followedRes.data.data as Array<Record<string, unknown>>;
    expect(followedList.some((s) => s.id === storeUuid)).toBe(true);

    // 4. User 2 unfollows the store
    const unfollowRes = await handle(
      json("POST", `/api/v1/stores/${storeUuid}/unfollow`, undefined, auth2),
    );
    expect(unfollowRes.status).toBe(200);
    expect(unfollowRes.data.success).toBe(true);
  });
});

describe("User Profile View Tracking", () => {
  let user1Token: string;
  let user2Token: string;
  let auth1: Record<string, string>;
  let auth2: Record<string, string>;

  beforeAll(async () => {
    user1Token = await mintJwtToken(SECRET, "1");
    user2Token = await mintJwtToken(SECRET, "2");
    auth1 = { Authorization: `Bearer ${user1Token}` };
    auth2 = { Authorization: `Bearer ${user2Token}` };
  });

  test("POST /api/v1/users/:id/view records profile view and throttles duplicates", async () => {
    // User 2 views User 1's profile
    const view1 = await handle(json("POST", "/api/v1/users/1/view", undefined, auth2));
    expect(view1.status).toBe(200);
    expect(view1.data.success).toBe(true);
    const view1Data = view1.data.data as Record<string, unknown>;
    expect(view1Data.throttled).toBe(false);

    // Immediate second view -> throttled = true
    const view2 = await handle(json("POST", "/api/v1/users/1/view", undefined, auth2));
    expect(view2.status).toBe(200);
    const view2Data = view2.data.data as Record<string, unknown>;
    expect(view2Data.throttled).toBe(true);
  });

  test("GET /api/v1/user/profile/analytics returns profile view count and recent viewers", async () => {
    const { status, data } = await handle(
      json("GET", "/api/v1/user/profile/analytics", undefined, auth1),
    );
    expect(status).toBe(200);
    expect(data.success).toBe(true);
    const analytics = data.data as Record<string, unknown>;
    expect(typeof analytics.profile_views_count).toBe("number");
    expect(Array.isArray(analytics.recent_viewers)).toBe(true);
  });
});

describe("Service Provider View Tracking & Analytics", () => {
  let user1Token: string;
  let user2Token: string;
  let user3Token: string;
  let auth1: Record<string, string>;
  let auth2: Record<string, string>;
  let auth3: Record<string, string>;
  let providerUuid: string;

  beforeAll(async () => {
    user1Token = await mintJwtToken(SECRET, "1");
    user2Token = await mintJwtToken(SECRET, "2");
    user3Token = await mintJwtToken(SECRET, "3");
    auth1 = { Authorization: `Bearer ${user1Token}` };
    auth2 = { Authorization: `Bearer ${user2Token}` };
    auth3 = { Authorization: `Bearer ${user3Token}` };

    // Create a fresh service provider for User 1
    const inserted = await db
      .insert(serviceProviders)
      .values({
        userId: 1,
        name: `Expert Auto Repairs ${Date.now()}`,
        slug: `expert-auto-repairs-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        serviceCategories: ["automotive"],
        isVerified: true,
      })
      .returning();
    providerUuid = inserted[0]!.uuid;
  });

  test("POST /api/v1/providers/:id/view records provider view and throttles duplicates", async () => {
    // User 2 views User 1's service provider page
    const view1 = await handle(
      json("POST", `/api/v1/providers/${providerUuid}/view`, undefined, auth2),
    );
    expect(view1.status).toBe(200);
    expect(view1.data.success).toBe(true);
    const view1Data = view1.data.data as Record<string, unknown>;
    expect(view1Data.throttled).toBe(false);
    expect(typeof view1Data.views_count).toBe("number");

    // Immediate second view -> throttled = true
    const view2 = await handle(
      json("POST", `/api/v1/providers/${providerUuid}/view`, undefined, auth2),
    );
    expect(view2.status).toBe(200);
    const view2Data = view2.data.data as Record<string, unknown>;
    expect(view2Data.throttled).toBe(true);
  });

  test("GET /api/v1/user/providers/:id/analytics returns provider views and viewers for owner", async () => {
    const res = await handle(
      json("GET", `/api/v1/user/providers/${providerUuid}/analytics`, undefined, auth1),
    );
    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
    const analytics = res.data.data as Record<string, unknown>;
    const provider = analytics.provider as Record<string, unknown>;
    expect(provider.uuid).toBe(providerUuid);
    expect(typeof provider.views_count).toBe("number");
    expect(Array.isArray(analytics.recent_viewers)).toBe(true);
  });

  test("GET /api/v1/user/providers/:id/analytics rejects unauthorized users with 403", async () => {
    const res = await handle(
      json("GET", `/api/v1/user/providers/${providerUuid}/analytics`, undefined, auth3),
    );
    expect(res.status).toBe(403);
  });
});

describe("Notification Settings Preferences", () => {
  let user1Token: string;
  let auth1: Record<string, string>;

  beforeAll(async () => {
    user1Token = await mintJwtToken(SECRET, "1");
    auth1 = { Authorization: `Bearer ${user1Token}` };
  });

  test("GET /api/v1/notifications/settings returns defaults", async () => {
    const res = await handle(
      json("GET", "/api/v1/notifications/settings", undefined, auth1),
    );
    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
    const body = res.data.data as Record<string, unknown>;
    const settings = body.settings as Record<string, boolean>;
    expect(settings.push_enabled).toBe(true);
    expect(settings.pushEnabled).toBe(true);
    expect(settings.email_enabled).toBe(true);
    expect(settings.view_notifications_push).toBe(true);
  });

  test("PUT /api/v1/notifications/settings updates preferences", async () => {
    const updateRes = await handle(
      json(
        "PUT",
        "/api/v1/notifications/settings",
        { email_hot_deals: false, push_new_messages: false },
        auth1,
      ),
    );
    expect(updateRes.status).toBe(200);
    expect(updateRes.data.success).toBe(true);
    const body = updateRes.data.data as Record<string, unknown>;
    const settings = body.settings as Record<string, boolean>;
    expect(settings.email_hot_deals).toBe(false);
    expect(settings.push_new_messages).toBe(false);
    expect(settings.email_enabled).toBe(true);
  });

  test("PATCH /api/v1/notifications/settings partially updates preferences", async () => {
    const patchRes = await handle(
      json(
        "PATCH",
        "/api/v1/notifications/settings",
        { email_hot_deals: true },
        auth1,
      ),
    );
    expect(patchRes.status).toBe(200);
    expect(patchRes.data.success).toBe(true);
    const body = patchRes.data.data as Record<string, unknown>;
    const settings = body.settings as Record<string, boolean>;
    expect(settings.email_hot_deals).toBe(true);
    expect(settings.push_new_messages).toBe(false);
  });
});

describe("Flexible Reviews & Target Aliases", () => {
  let user2Token: string;
  let auth2: Record<string, string>;

  beforeAll(async () => {
    user2Token = await mintJwtToken(SECRET, "2");
    auth2 = { Authorization: `Bearer ${user2Token}` };
  });

  test("POST /api/v1/reviews accepts user/seller target and reviewable aliases", async () => {
    // User 2 reviews User 1 (seller/user)
    const res = await handle(
      json(
        "POST",
        "/api/v1/reviews",
        {
          reviewable_type: "user",
          reviewable_id: "1",
          rating: 5,
          comment: "Excellent service and reliable seller!",
        },
        auth2,
      ),
    );
    // Could be 201 or 409 if previously reviewed
    expect([201, 409]).toContain(res.status);
    if (res.status === 201) {
      expect(res.data.success).toBe(true);
    }
  });

  test("GET /api/v1/reviews lists reviews using target aliases", async () => {
    const res = await handle(
      json("GET", "/api/v1/reviews?target_type=user&target_id=1"),
    );
    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
    const meta = (res.data as Record<string, unknown>).meta as Record<string, unknown>;
    expect(meta).toBeDefined();
    expect(meta.total).toBeDefined();
    expect(typeof meta.average_rating).toBe("number");
  });
});

