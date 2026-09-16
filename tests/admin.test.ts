// tests/admin.test.ts
//
// Admin module: role-guard logic, staff/admin-only enforcement, dashboard
// stats aggregation shape, and the KYC / applications / users / markets /
// support / contact-update / advert / listing / broadcast review flows
// via app.handle.

import { test, expect, describe, beforeAll, beforeEach } from "bun:test";
import {
  AdminStore,
  buildDashboardStats,
  createAdminPlugin,
  hasRequiredRole,
  staffAccessError,
} from "../src/modules/admin/index";
import { MemoryUserStore, mintJwtToken } from "../src/modules/auth/index";
import { nowIso } from "../src/utils/phone";

const SECRET = "test-secret-for-admin";

function json(method: string, path: string, body?: unknown, headers?: Record<string, string>) {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(headers ?? {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function handle(app: { handle: (req: Request) => Promise<Response> }, req: Request) {
  const res = await app.handle(req);
  const data = (await res.json()) as Record<string, unknown>;
  return { status: res.status, data };
}

let store: AdminStore;
let users: MemoryUserStore;
let app: ReturnType<typeof createAdminPlugin>;
let ADMIN: Record<string, string>;
let VERIFIER: Record<string, string>;
let BUYER: Record<string, string>;
let ADMIN_ID: string;
let VERIFIER_ID: string;

function seedUser(id: string, roles: string[], name = `User ${id}`): void {
  store.users.set(id, {
    id,
    name,
    email: `${id}@example.com`,
    roles,
    state: "Lagos",
    isSuspended: false,
    suspensionReason: null,
    createdAt: nowIso(),
  });
}

beforeAll(async () => {
  users = new MemoryUserStore();
  const admin = await users.create({ name: "Ada", email: "ada@example.com" });
  await users.update(admin.id, { roles: ["admin"] });
  const verifier = await users.create({ name: "Vera", email: "vera@example.com" });
  await users.update(verifier.id, { roles: ["verifier"] });
  const buyer = await users.create({ name: "Bob", email: "bob@example.com" });
  await users.update(buyer.id, { roles: ["buyer"] });
  ADMIN_ID = admin.id;
  VERIFIER_ID = verifier.id;
  ADMIN = { authorization: `Bearer ${await mintJwtToken(SECRET, admin.id)}` };
  VERIFIER = { authorization: `Bearer ${await mintJwtToken(SECRET, verifier.id)}` };
  BUYER = { authorization: `Bearer ${await mintJwtToken(SECRET, buyer.id)}` };
});

beforeEach(() => {
  store = new AdminStore();
  app = createAdminPlugin({ store, users, secret: SECRET });
});

describe("role guard logic", () => {
  test("pipe syntax matches either staff role", () => {
    expect(hasRequiredRole(["admin"], "admin|verifier")).toBe(true);
    expect(hasRequiredRole(["verifier"], "admin|verifier")).toBe(true);
    expect(hasRequiredRole(["buyer"], "admin|verifier")).toBe(false);
    expect(hasRequiredRole([], "admin|verifier")).toBe(false);
  });

  test("array form and admin-only checks", () => {
    expect(hasRequiredRole(["verifier"], ["admin", "verifier"])).toBe(true);
    expect(hasRequiredRole(["verifier"], "admin")).toBe(false);
    expect(hasRequiredRole(["admin", "verifier"], "admin")).toBe(true);
  });

  test("staffAccessError maps no user / non-staff / staff to 401 / 403 / null", () => {
    expect(staffAccessError(null, "admin|verifier")?.status).toBe(401);
    const buyer = { id: "u1", name: "Bob", roles: ["buyer"] };
    expect(staffAccessError(buyer, "admin|verifier")?.status).toBe(403);
    const admin = { id: "a1", name: "Ada", roles: ["admin"] };
    expect(staffAccessError(admin, "admin|verifier")).toBeNull();
  });

  test("staff routes reject unauthenticated and non-staff callers", async () => {
    const anon = await handle(app, json("GET", "/api/v1/admin/dashboard/stats"));
    expect(anon.status).toBe(401);
    const buyer = await handle(app, json("GET", "/api/v1/admin/dashboard/stats", undefined, BUYER));
    expect(buyer.status).toBe(403);
  });
});

describe("dashboard stats", () => {
  test("buildDashboardStats() returns the reference aggregate shape", () => {
    const stats = buildDashboardStats({
      totalUsers: 10,
      totalListings: 4,
      activeListings: 2,
      pendingListings: 1,
      totalStores: 3,
      totalProviders: 5,
      totalTransactions: 7,
      revenueTotal: 150000,
    });
    expect(stats).toEqual({
      total_users: 10,
      total_listings: 4,
      active_listings: 2,
      pending_listings: 1,
      total_stores: 3,
      total_providers: 5,
      total_transactions: 7,
      revenue_total: 150000,
    });
  });

  test("GET /dashboard/stats aggregates the store", async () => {
    seedUser("u1", ["buyer"]);
    seedUser("u2", ["seller"]);
    store.listings.set("l1", {
      id: "l1", userId: "u1", title: "A", dealType: "distress",
      status: "active", approved: true, featured: false, promoted: false,
      promotionType: null, promotionExpiry: null, createdAt: nowIso(),
    });
    store.listings.set("l2", {
      id: "l2", userId: "u2", title: "B", dealType: "standard",
      status: "pending", approved: false, featured: false, promoted: false,
      promotionType: null, promotionExpiry: null, createdAt: nowIso(),
    });
    store.counters = { totalStores: 6, totalProviders: 2, totalTransactions: 9, revenueTotal: 42500 };

    const { status, data } = await handle(
      app, json("GET", "/api/v1/admin/dashboard/stats", undefined, VERIFIER),
    );
    expect(status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.data).toEqual({
      total_users: 2,
      total_listings: 2,
      active_listings: 1,
      pending_listings: 1,
      total_stores: 6,
      total_providers: 2,
      total_transactions: 9,
      revenue_total: 42500,
    });
  });
});

describe("kyc review", () => {
  beforeEach(() => {
    store.kyc.set("kyc_1", {
      id: "kyc_1", userId: "u1", tier: 1, status: "pending",
      rejectionReason: null, reviewedBy: null, reviewedAt: null, createdAt: nowIso(),
    });
  });

  test("verifier can list, approve and reject", async () => {
    const list = await handle(app, json("GET", "/api/v1/admin/kyc?status=pending", undefined, VERIFIER));
    expect(list.status).toBe(200);
    expect((list.data.data as unknown[]).length).toBe(1);

    const approved = await handle(app, json("POST", "/api/v1/admin/kyc/kyc_1/approve", undefined, VERIFIER));
    expect(approved.status).toBe(200);
    expect(store.kyc.get("kyc_1")?.status).toBe("approved");

    const rejected = await handle(app, json("POST", "/api/v1/admin/kyc/kyc_1/reject", { reason: "Blurry" }, VERIFIER));
    expect(rejected.status).toBe(200);
    expect(store.kyc.get("kyc_1")?.rejectionReason).toBe("Blurry");
  });

  test("reject requires a reason; unknown ids 404", async () => {
    const noReason = await handle(app, json("POST", "/api/v1/admin/kyc/kyc_1/reject", {}, VERIFIER));
    expect(noReason.status).toBe(422);
    const missing = await handle(app, json("POST", "/api/v1/admin/kyc/nope/approve", undefined, ADMIN));
    expect(missing.status).toBe(404);
  });
});

describe("application review", () => {
  beforeEach(() => {
    seedUser("u1", ["buyer"]);
    const base = { userId: "u1", status: "pending" as const, declinedReason: null, reviewedBy: null, reviewedAt: null, createdAt: nowIso() };
    store.sellerApps.set("s1", { ...base, id: "s1" });
    store.providerApps.set("p1", { ...base, id: "p1" });
  });

  test("approve grants the role; decline requires a reason", async () => {
    const approved = await handle(app, json("POST", "/api/v1/admin/applications/sellers/s1/approve", undefined, ADMIN));
    expect(approved.status).toBe(200);
    expect(store.users.get("u1")?.roles).toContain("seller");

    const noReason = await handle(app, json("POST", "/api/v1/admin/applications/providers/p1/decline", {}, ADMIN));
    expect(noReason.status).toBe(422);

    const declined = await handle(
      app, json("POST", "/api/v1/admin/applications/providers/p1/decline", { reason: "No docs" }, ADMIN),
    );
    expect(declined.status).toBe(200);
    expect(store.providerApps.get("p1")?.status).toBe("declined");
  });

  test("queues are listable", async () => {
    const sellers = await handle(app, json("GET", "/api/v1/admin/applications/sellers", undefined, VERIFIER));
    expect(sellers.status).toBe(200);
    expect((sellers.data.data as unknown[]).length).toBe(1);
    const providers = await handle(app, json("GET", "/api/v1/admin/applications/providers", undefined, VERIFIER));
    expect(providers.status).toBe(200);
  });
});

describe("user management", () => {
  beforeEach(() => {
    seedUser("u1", ["buyer"], "Buyer One");
    seedUser("admin_1", ["admin"], "Ada");
  });

  test("suspend / unsuspend are admin-only", async () => {
    const forbidden = await handle(
      app, json("POST", "/api/v1/admin/users/u1/suspend", { reason: "spam" }, VERIFIER),
    );
    expect(forbidden.status).toBe(403);

    const suspended = await handle(
      app, json("POST", "/api/v1/admin/users/u1/suspend", { reason: "spam" }, ADMIN),
    );
    expect(suspended.status).toBe(200);
    expect(store.users.get("u1")?.isSuspended).toBe(true);

    const unsuspended = await handle(app, json("POST", "/api/v1/admin/users/u1/unsuspend", undefined, ADMIN));
    expect(unsuspended.status).toBe(200);
    expect(store.users.get("u1")?.isSuspended).toBe(false);
  });

  test("assign-role grants and revokes staff roles", async () => {
    const granted = await handle(
      app, json("POST", "/api/v1/admin/users/u1/assign-role", { role: "verifier", action: "grant" }, ADMIN),
    );
    expect(granted.status).toBe(200);
    expect(store.users.get("u1")?.roles).toContain("verifier");

    const revoked = await handle(
      app, json("POST", "/api/v1/admin/users/u1/assign-role", { role: "verifier", action: "revoke" }, ADMIN),
    );
    expect(revoked.status).toBe(200);
    expect(store.users.get("u1")?.roles).not.toContain("verifier");
  });

  test("users list supports role and search filters", async () => {
    const all = await handle(app, json("GET", "/api/v1/admin/users", undefined, VERIFIER));
    expect((all.data.data as unknown[]).length).toBe(2);
    const buyers = await handle(app, json("GET", "/api/v1/admin/users?role=buyer", undefined, VERIFIER));
    expect((buyers.data.data as unknown[]).length).toBe(1);
    const search = await handle(app, json("GET", "/api/v1/admin/users?search=buyer+one", undefined, VERIFIER));
    expect((search.data.data as unknown[]).length).toBe(1);
  });
});

describe("markets crud", () => {
  test("create, list, update and delete", async () => {
    const created = await handle(
      app, json("POST", "/api/v1/admin/markets", { state_id: "st1", name: "Balogun Market" }, ADMIN),
    );
    expect(created.status).toBe(201);
    const market = created.data.data as Record<string, unknown>;
    expect(market.slug).toBe("balogun-market");

    const listed = await handle(app, json("GET", "/api/v1/admin/markets", undefined, VERIFIER));
    expect((listed.data.data as unknown[]).length).toBe(1);

    const updated = await handle(
      app, json("PUT", `/api/v1/admin/markets/${market.id}`, { is_active: false }, ADMIN),
    );
    expect(updated.status).toBe(200);
    expect((updated.data.data as Record<string, unknown>).is_active).toBe(false);

    const deleted = await handle(app, json("DELETE", `/api/v1/admin/markets/${market.id}`, undefined, ADMIN));
    expect(deleted.status).toBe(200);
    expect(store.markets.size).toBe(0);
  });

  test("create requires name and state_id", async () => {
    const { status } = await handle(app, json("POST", "/api/v1/admin/markets", { name: "X" }, ADMIN));
    expect(status).toBe(422);
  });
});

describe("support queue + contact updates", () => {
  beforeEach(() => {
    seedUser("admin_1", ["admin"], "Ada");
    seedUser("ver_1", ["verifier"], "Vera");
    store.tickets.set("t1", {
      id: "t1", ticketNumber: "DN-SUP-1001", userId: "u9", subject: "Help",
      status: "open", priority: "urgent", category: "general_inquiry",
      assignedTo: null, createdAt: nowIso(),
    });
    store.contactUpdates.set("c1", {
      id: "c1", providerId: "pr1", proposedChanges: { phone: "+2348012345678" },
      status: "pending", reviewedBy: null, reviewedAt: null, createdAt: nowIso(),
    });
  });

  test("tickets list and self-assign", async () => {
    const listed = await handle(app, json("GET", "/api/v1/admin/support/tickets", undefined, VERIFIER));
    expect(listed.status).toBe(200);
    const assigned = await handle(app, json("POST", "/api/v1/admin/support/tickets/t1/assign", {}, VERIFIER));
    expect(assigned.status).toBe(200);
    expect(store.tickets.get("t1")?.assignedTo).toBe(VERIFIER_ID);
  });

  test("contact update approve then double-review 422s", async () => {
    const approved = await handle(app, json("POST", "/api/v1/admin/contact-updates/c1/approve", undefined, VERIFIER));
    expect(approved.status).toBe(200);
    const again = await handle(app, json("POST", "/api/v1/admin/contact-updates/c1/reject", undefined, VERIFIER));
    expect(again.status).toBe(422);
  });
});

describe("adverts", () => {
  beforeEach(() => {
    store.adverts.set("a1", {
      id: "a1", userId: "u1", title: "Sale", status: "pending",
      durationDays: 7, amountPaid: 5000, publishedAt: null, expiresAt: null, createdAt: nowIso(),
    });
  });

  test("stats, publish and unpublish", async () => {
    const stats = await handle(app, json("GET", "/api/v1/admin/adverts/stats", undefined, VERIFIER));
    expect((stats.data.data as Record<string, unknown>).pending).toBe(1);
    expect((stats.data.data as Record<string, unknown>).revenue).toBe(5000);

    const published = await handle(app, json("POST", "/api/v1/admin/adverts/a1/publish", undefined, VERIFIER));
    expect(published.status).toBe(200);
    expect(store.adverts.get("a1")?.status).toBe("active");
    expect(store.adverts.get("a1")?.expiresAt).not.toBeNull();

    const unpublished = await handle(app, json("POST", "/api/v1/admin/adverts/a1/unpublish", undefined, VERIFIER));
    expect(unpublished.status).toBe(200);
    expect(store.adverts.get("a1")?.status).toBe("unpublished");
  });
});

describe("listings review + featuring", () => {
  beforeEach(() => {
    store.listings.set("l1", {
      id: "l1", userId: "u1", title: "Distress TV", dealType: "distress",
      status: "pending", approved: false, featured: false, promoted: false,
      promotionType: null, promotionExpiry: null, createdAt: nowIso(),
    });
  });

  test("approve goes live; reject needs a reason", async () => {
    const approved = await handle(app, json("POST", "/api/v1/admin/listings/l1/approve", undefined, VERIFIER));
    expect(approved.status).toBe(200);
    expect(store.listings.get("l1")?.status).toBe("active");

    const noReason = await handle(app, json("POST", "/api/v1/admin/listings/l1/reject", {}, VERIFIER));
    expect(noReason.status).toBe(422);

    const rejected = await handle(
      app, json("POST", "/api/v1/admin/listings/l1/reject", { reason: "Prohibited item" }, VERIFIER),
    );
    expect(rejected.status).toBe(200);
    expect(store.listings.get("l1")?.status).toBe("inactive");
  });

  test("featuring is admin-only", async () => {
    const forbidden = await handle(app, json("POST", "/api/v1/admin/listings/l1/feature", { days: 7 }, VERIFIER));
    expect(forbidden.status).toBe(403);

    const featured = await handle(
      app, json("POST", "/api/v1/admin/listings/l1/feature", { days: 7 }, ADMIN),
    );
    expect(featured.status).toBe(200);
    expect(store.listings.get("l1")?.featured).toBe(true);
    expect(store.listings.get("l1")?.promotionExpiry).not.toBeNull();
  });
});

describe("notification broadcasts", () => {
  beforeEach(() => {
    seedUser("u1", ["buyer"]);
    seedUser("u2", ["buyer"]);
    seedUser("admin_1", ["admin"], "Ada");
  });

  test("dry run previews the audience; send requires confirm", async () => {
    const dry = await handle(
      app, json("POST", "/api/v1/admin/notifications/broadcast", {
        title: "Hello", body: "World", dry_run: true,
      }, ADMIN),
    );
    expect(dry.status).toBe(200);
    expect((dry.data.data as Record<string, unknown>).recipient_count).toBe(3);
    expect(store.broadcasts.length).toBe(0);

    const unconfirmed = await handle(
      app, json("POST", "/api/v1/admin/notifications/broadcast", { title: "Hello", body: "World" }, ADMIN),
    );
    expect(unconfirmed.status).toBe(422);

    const sent = await handle(
      app, json("POST", "/api/v1/admin/notifications/broadcast", {
        title: "Hello", body: "World", confirm: true,
      }, ADMIN),
    );
    expect(sent.status).toBe(202);
    expect(store.broadcasts.length).toBe(1);
  });

  test("verifiers cannot broadcast; sends are throttled", async () => {
    const forbidden = await handle(
      app, json("POST", "/api/v1/admin/notifications/broadcast", {
        title: "Hi", body: "There", confirm: true,
      }, VERIFIER),
    );
    expect(forbidden.status).toBe(403);

    for (let i = 0; i < 3; i++) {
      const res = await handle(
        app, json("POST", "/api/v1/admin/notifications/broadcast", {
          title: `Hi ${i}`, body: "There", confirm: true,
        }, ADMIN),
      );
      expect(res.status).toBe(202);
    }
    const throttled = await handle(
      app, json("POST", "/api/v1/admin/notifications/broadcast", {
        title: "Too much", body: "Slow down", confirm: true,
      }, ADMIN),
    );
    expect(throttled.status).toBe(429);
  });

  test("broadcasts are listable by admins", async () => {
    await handle(
      app, json("POST", "/api/v1/admin/notifications/broadcast", {
        title: "Hello", body: "World", confirm: true,
      }, ADMIN),
    );
    const listed = await handle(app, json("GET", "/api/v1/admin/notifications/broadcasts", undefined, ADMIN));
    expect(listed.status).toBe(200);
    expect(((listed.data.data as Record<string, unknown>).broadcasts as unknown[]).length).toBe(1);
  });
});
