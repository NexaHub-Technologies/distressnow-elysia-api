// tests/payments.test.ts
//
// Payments module: Paystack webhook HMAC verification, mock-mode service
// calls, and route-level tests (auth guard, initialize/verify/webhook)
// via app.handle.

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { createHmac } from "node:crypto";
import {
  isMockMode,
  mapGatewayStatus,
  initializeTransaction,
  verifyTransaction,
  verifyWebhookSignature,
} from "../src/services/paystack";
import {
  createPaymentsPlugin,
  generateReference,
  MemoryTransactionStore,
} from "../src/modules/payments/index";

const SECRET_KEYS = ["PAYSTACK_SECRET_KEY", "PAYSTACK_SECRET"] as const;
const savedEnv: Record<string, string | undefined> = {};

function clearPaystackSecrets(): void {
  for (const key of SECRET_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
}

function restorePaystackSecrets(): void {
  for (const key of SECRET_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
}

function sign(payload: string, secret: string): string {
  return createHmac("sha512", secret).update(payload, "utf8").digest("hex");
}

function json(method: string, path: string, body?: unknown, headers?: Record<string, string>) {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(headers ?? {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function rawJson(method: string, path: string, raw: string, headers?: Record<string, string>) {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(headers ?? {}) },
    body: raw,
  });
}

async function handle(app: { handle: (req: Request) => Promise<Response> }, req: Request) {
  const res = await app.handle(req);
  const data = (await res.json()) as Record<string, unknown>;
  return { status: res.status, data };
}

const AUTH = { "x-user-id": "user_1", "x-user-email": "buyer@example.com" };

describe("webhook signature verification", () => {
  const secret = "test-secret-key";
  const payload = JSON.stringify({ event: "charge.success", data: { reference: "TXN-ABC" } });

  test("accepts a valid HMAC-SHA512 signature", () => {
    expect(verifyWebhookSignature(payload, sign(payload, secret), secret)).toBe(true);
  });

  test("rejects a tampered payload", () => {
    const tampered = payload.replace("TXN-ABC", "TXN-XYZ");
    expect(verifyWebhookSignature(tampered, sign(payload, secret), secret)).toBe(false);
  });

  test("rejects a wrong signature", () => {
    expect(verifyWebhookSignature(payload, "0".repeat(128), secret)).toBe(false);
  });

  test("rejects empty signature / payload / secret", () => {
    expect(verifyWebhookSignature(payload, "", secret)).toBe(false);
    expect(verifyWebhookSignature("", sign(payload, secret), secret)).toBe(false);
    expect(verifyWebhookSignature(payload, sign(payload, secret), "")).toBe(false);
  });
});

describe("gateway status mapping", () => {
  test("maps Paystack statuses to transaction statuses", () => {
    expect(mapGatewayStatus("success")).toBe("success");
    expect(mapGatewayStatus("reversed")).toBe("reversed");
    expect(mapGatewayStatus("failed")).toBe("failed");
    expect(mapGatewayStatus("abandoned")).toBe("failed");
    expect(mapGatewayStatus(undefined)).toBe("failed");
    expect(mapGatewayStatus("bogus")).toBe("failed");
  });
});

describe("paystack mock mode", () => {
  beforeEach(clearPaystackSecrets);
  afterEach(restorePaystackSecrets);

  test("isMockMode() is true without a secret", () => {
    expect(isMockMode()).toBe(true);
  });

  test("initialize returns a mock authorization URL", async () => {
    const result = await initializeTransaction({
      email: "buyer@example.com",
      amountKobo: 50000,
      reference: "TXN-MOCK1",
    });
    expect(result.reference).toBe("TXN-MOCK1");
    expect(result.authorization_url).toContain("TXN-MOCK1");
    expect(result.access_code).toContain("TXN-MOCK1");
  });

  test("verify returns a mock success payload", async () => {
    const result = await verifyTransaction("TXN-MOCK1");
    expect(result.status).toBe("success");
    expect(result.reference).toBe("TXN-MOCK1");
    expect(result.mock).toBe(true);
  });

  test("initialize rejects amounts below ₦100", async () => {
    await expect(
      initializeTransaction({ email: "a@b.com", amountKobo: 9999, reference: "TXN-X" }),
    ).rejects.toThrow();
  });
});

describe("payments routes", () => {
  let store: MemoryTransactionStore;
  let app: ReturnType<typeof createPaymentsPlugin>;

  beforeEach(() => {
    clearPaystackSecrets();
    store = new MemoryTransactionStore();
    app = createPaymentsPlugin({ store });
  });

  afterEach(restorePaystackSecrets);

  test("POST /initialize requires auth", async () => {
    const { status, data } = await handle(app, json("POST", "/api/v1/payments/initialize", { amount: 500 }));
    expect(status).toBe(401);
    expect(data.success).toBe(false);
  });

  test("POST /initialize creates a pending transaction (mock mode)", async () => {
    const { status, data } = await handle(
      app,
      json("POST", "/api/v1/payments/initialize", { amount: 500 }, AUTH),
    );
    expect(status).toBe(201);
    expect(data.success).toBe(true);
    const payload = data.data as Record<string, unknown>;
    expect(typeof payload.authorization_url).toBe("string");
    expect(typeof payload.reference).toBe("string");
    expect((payload.reference as string).startsWith("TXN-")).toBe(true);
    const stored = store.findByReference(payload.reference as string);
    expect(stored?.status).toBe("pending");
    expect(stored?.amountKobo).toBe(50000);
  });

  test("POST /initialize rejects amounts below ₦100", async () => {
    const { status } = await handle(
      app,
      json("POST", "/api/v1/payments/initialize", { amount: 50 }, AUTH),
    );
    expect(status).toBe(422);
  });

  test("POST /verify returns 404 for unknown references", async () => {
    const { status, data } = await handle(
      app,
      json("POST", "/api/v1/payments/verify", { reference: "TXN-NOPE" }, AUTH),
    );
    expect(status).toBe(404);
    expect(data.success).toBe(false);
  });

  test("POST /verify marks a pending transaction successful (mock mode)", async () => {
    const init = await handle(
      app,
      json("POST", "/api/v1/payments/initialize", { amount: 250 }, AUTH),
    );
    const reference = (init.data.data as Record<string, unknown>).reference as string;

    const { status, data } = await handle(
      app,
      json("POST", "/api/v1/payments/verify", { reference }, AUTH),
    );
    expect(status).toBe(200);
    expect(data.success).toBe(true);
    expect(store.findByReference(reference)?.status).toBe("success");
  });

  test("POST /verify reports already-processed transactions", async () => {
    const reference = generateReference();
    store.create({ userId: "user_1", reference, amount: 100, amountKobo: 10000 });
    store.update(reference, { status: "success" });

    const { status, data } = await handle(
      app,
      json("POST", "/api/v1/payments/verify", { reference }, AUTH),
    );
    expect(status).toBe(200);
    expect(data.message).toContain("already processed");
  });

  test("POST /webhook processes charge.success with a valid signature", async () => {
    const secret = "webhook-test-secret";
    process.env.PAYSTACK_SECRET_KEY = secret;
    const reference = generateReference();
    store.create({ userId: "user_1", reference, amount: 100, amountKobo: 10000 });

    const payload = JSON.stringify({
      event: "charge.success",
      data: { reference, channel: "card", gateway_response: "Approved" },
    });
    const { status, data } = await handle(
      app,
      rawJson("POST", "/api/v1/payments/webhook", payload, {
        "x-paystack-signature": sign(payload, secret),
      }),
    );
    expect(status).toBe(200);
    expect(data.success).toBe(true);
    expect(store.findByReference(reference)?.status).toBe("success");
    expect(store.findByReference(reference)?.channel).toBe("card");
  });

  test("POST /webhook rejects invalid signatures", async () => {
    process.env.PAYSTACK_SECRET_KEY = "webhook-test-secret";
    const payload = JSON.stringify({ event: "charge.success", data: {} });
    const { status } = await handle(
      app,
      rawJson("POST", "/api/v1/payments/webhook", payload, {
        "x-paystack-signature": "invalid",
      }),
    );
    expect(status).toBe(401);
  });

  test("POST /webhook rejects missing signatures", async () => {
    process.env.PAYSTACK_SECRET_KEY = "webhook-test-secret";
    const { status } = await handle(
      app,
      rawJson("POST", "/api/v1/payments/webhook", JSON.stringify({ event: "x" })),
    );
    expect(status).toBe(401);
  });
});
