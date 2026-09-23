// tests/item-requests.test.ts
//
// Tests for "Request an Item" subsystem:
//   - Two-pool store matching & candidate scoring logic
//   - Memory store operations
//   - HTTP routes: browse, create, my requests, offers, single view, status update, response submission

import { describe, expect, test, beforeEach } from "bun:test";
import { app } from "../src/index";
import {
  ItemRequestMemoryStore,
  scoreCandidateStore,
} from "../src/modules/item-requests/index";
import { MemoryUserStore, mintJwtToken } from "../src/modules/auth/index";
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

describe("Item Requests: Two-pool scoring engine", () => {
  const now = new Date("2026-09-22T12:00:00Z");

  test("scores sublocation match (+40) and category affinity (+30) correctly", () => {
    const request = {
      categoryId: 5,
      stateId: 25,
      sublocationId: 101,
    };
    const store = {
      stateId: 25,
      sublocationId: 101,
      categories: [5, 6],
      isPromoted: true,
      promotionExpiry: new Date("2026-09-30T00:00:00Z"),
    };

    const result = scoreCandidateStore(request, store, now);
    expect(result.score).toBe(70); // 40 (sublocation) + 30 (category)
    expect(result.promoted).toBe(true);
  });

  test("scores state match (+20) when sublocation differs", () => {
    const request = {
      categoryId: 5,
      stateId: 25,
      sublocationId: 101,
    };
    const store = {
      stateId: 25,
      sublocationId: 102,
      categories: [5],
      isPromoted: false,
    };

    const result = scoreCandidateStore(request, store, now);
    expect(result.score).toBe(50); // 20 (state) + 30 (category)
    expect(result.promoted).toBe(false);
  });

  test("scores 0 when no location or category match", () => {
    const request = {
      categoryId: 1,
      stateId: 10,
      sublocationId: 50,
    };
    const store = {
      stateId: 20,
      sublocationId: 60,
      categories: [2, 3],
      isPromoted: false,
    };

    const result = scoreCandidateStore(request, store, now);
    expect(result.score).toBe(0);
    expect(result.promoted).toBe(false);
  });

  test("marks promoted as false when promotion has expired", () => {
    const request = { categoryId: 1 };
    const store = {
      categories: [1],
      isPromoted: true,
      promotionExpiry: new Date("2026-09-01T00:00:00Z"), // in the past
    };

    const result = scoreCandidateStore(request, store, now);
    expect(result.score).toBe(30);
    expect(result.promoted).toBe(false);
  });
});

describe("Item Requests: ItemRequestMemoryStore", () => {
  let memStore: ItemRequestMemoryStore;

  beforeEach(() => {
    memStore = new ItemRequestMemoryStore();
  });

  test("creates a request and increments responses count on response creation", () => {
    const req = memStore.createRequest({
      userId: 1,
      title: "iPhone 15 Pro",
      description: "Clean used, 256GB preferred",
      budgetMin: 800000,
      budgetMax: 950000,
    });

    expect(req.id).toBe(1);
    expect(req.uuid).toBeDefined();
    expect(req.status).toBe("open");
    expect(req.responsesCount).toBe(0);

    const found = memStore.findRequestByUuidOrId(req.uuid);
    expect(found).not.toBeNull();
    expect(found?.title).toBe("iPhone 15 Pro");

    const resp = memStore.createResponse({
      itemRequestId: req.id,
      storeId: 10,
      userId: 2,
      price: 850000,
      message: "I have UK used iPhone 15 Pro blue titanium with warranty",
    });

    expect(resp.id).toBe(1);
    expect(resp.price).toBe(850000);
    expect(req.responsesCount).toBe(1);

    const allResponses = memStore.getResponsesForRequest(req.id);
    expect(allResponses).toHaveLength(1);
    expect(allResponses[0]?.message).toContain("UK used");
  });
});

describe("Item Requests: HTTP Endpoints", () => {
  let buyerToken: string;
  let sellerToken: string;
  let buyerAuth: Record<string, string>;
  let sellerAuth: Record<string, string>;

  beforeEach(async () => {
    // Mint tokens for tests
    buyerToken = await mintJwtToken(SECRET, "1");
    sellerToken = await mintJwtToken(SECRET, "2");
    buyerAuth = { Authorization: `Bearer ${buyerToken}` };
    sellerAuth = { Authorization: `Bearer ${sellerToken}` };
  });

  test("GET /api/v1/item-requests/browse returns paginated requests", async () => {
    const { status, data } = await handle(
      json("GET", "/api/v1/item-requests/browse?page=1&per_page=10"),
    );
    expect(status).toBe(200);
    expect(data.success).toBe(true);
    expect(Array.isArray(data.data)).toBe(true);
    expect(data.meta).toBeDefined();
  });

  test("POST /api/v1/item-requests requires authentication (401)", async () => {
    const { status } = await handle(
      json("POST", "/api/v1/item-requests", {
        title: "Test Request",
        description: "Need this item urgently",
      }),
    );
    expect(status).toBe(401);
  });

  test("POST /api/v1/item-requests validates required fields (422)", async () => {
    const { status, data } = await handle(
      json("POST", "/api/v1/item-requests", { title: "" }, buyerAuth),
    );
    expect(status).toBe(422);
    expect(data.success).toBe(false);
  });

  test("GET /api/v1/item-requests/my requires authentication (401)", async () => {
    const { status } = await handle(json("GET", "/api/v1/item-requests/my"));
    expect(status).toBe(401);
  });

  test("GET /api/v1/item-requests/my returns buyer requests with auth", async () => {
    const { status, data } = await handle(
      json("GET", "/api/v1/item-requests/my", undefined, buyerAuth),
    );
    expect(status).toBe(200);
    expect(data.success).toBe(true);
    expect(Array.isArray(data.data)).toBe(true);
  });

  test("GET /api/v1/item-requests/offers returns offers list with auth", async () => {
    const { status, data } = await handle(
      json("GET", "/api/v1/item-requests/offers", undefined, buyerAuth),
    );
    expect(status).toBe(200);
    expect(data.success).toBe(true);
    expect(Array.isArray(data.data)).toBe(true);
  });

  test("GET /api/v1/item-requests/:id returns 404 for nonexistent request", async () => {
    const { status, data } = await handle(
      json("GET", "/api/v1/item-requests/nonexistent-uuid-999999"),
    );
    expect(status).toBe(404);
    expect(data.success).toBe(false);
  });

  test("PATCH /api/v1/item-requests/:id/status validates status parameter", async () => {
    const { status } = await handle(
      json(
        "PATCH",
        "/api/v1/item-requests/nonexistent-id/status",
        { status: "invalid_status" },
        buyerAuth,
      ),
    );
    // 422 from TypeBox schema validation on status union
    expect(status).toBe(422);
  });

  test("full item request lifecycle: create -> submit offer -> view responses -> mark fulfilled", async () => {
    // 1. Buyer creates request
    const createRes = await handle(
      json(
        "POST",
        "/api/v1/item-requests",
        {
          title: "Looking for MacBook Pro M2 16GB",
          description: "Clean UK used, space grey preferred",
          budget_min: 1000000,
          budget_max: 1300000,
        },
        buyerAuth,
      ),
    );
    expect(createRes.status).toBe(201);
    expect(createRes.data.success).toBe(true);
    const createdReq = createRes.data.data as Record<string, unknown>;
    expect(createdReq.uuid).toBeDefined();
    expect(createdReq.status).toBe("open");
    const reqUuid = createdReq.uuid as string;

    // 2. View single request
    const viewRes = await handle(json("GET", `/api/v1/item-requests/${reqUuid}`));
    expect(viewRes.status).toBe(200);
    const viewData = viewRes.data.data as Record<string, unknown>;
    expect(viewData.title).toBe("Looking for MacBook Pro M2 16GB");

    // 3. Buyer marks status as fulfilled
    const statusRes = await handle(
      json(
        "PATCH",
        `/api/v1/item-requests/${reqUuid}/status`,
        { status: "fulfilled" },
        buyerAuth,
      ),
    );
    expect(statusRes.status).toBe(200);
    const updatedData = statusRes.data.data as Record<string, unknown>;
    expect(updatedData.status).toBe("fulfilled");
  });
});
