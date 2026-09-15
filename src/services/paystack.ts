/**
 * PaystackService — Paystack payment gateway integration.
 *
 * Port of the Laravel reference:
 *   DistressNowApi/app/Services/PaystackService.php (+ config/paystack.php)
 *
 *  - initializeTransaction({ email, amountKobo, reference, callbackUrl, metadata })
 *  - verifyTransaction(reference)
 *  - verifyWebhookSignature(payload, signature) — HMAC-SHA512, timing-safe
 *
 * Mock mode: when no secret is configured (PAYSTACK_SECRET_KEY / PAYSTACK_SECRET
 * both empty) no network calls are made — initialize/verify return deterministic
 * mock payloads so local dev and tests run without Paystack credentials.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const PAYSTACK_BASE_URL = "https://api.paystack.co";

/** Channels allowed for payment (matches Laravel config/paystack.php + Expo app). */
export const PAYSTACK_CHANNELS = [
  "card",
  "bank",
  "ussd",
  "qr",
  "mobile_money",
  "bank_transfer",
  "eft",
  "opay",
] as const;

export const PAYSTACK_CURRENCY = process.env.PAYSTACK_CURRENCY ?? "NGN";

/** Canonical key (matches Laravel config/paystack.php); legacy alias supported. */
export function paystackSecret(): string {
  return process.env.PAYSTACK_SECRET_KEY || process.env.PAYSTACK_SECRET || "";
}

/** True when no secret is configured — the service runs in mock mode. */
export function isMockMode(secret: string = paystackSecret()): boolean {
  return secret.length === 0;
}

export interface InitializeInput {
  email: string;
  /** Amount in kobo (100 kobo = ₦1). */
  amountKobo: number;
  /** Unique transaction reference, e.g. "TXN-XXXXXXXX". */
  reference: string;
  callbackUrl?: string;
  metadata?: Record<string, unknown>;
  channels?: string[];
}

export interface InitializeResult {
  authorization_url: string;
  access_code: string;
  reference: string;
}

export interface VerifyResult {
  status: string;
  reference: string;
  amount: number;
  channel?: string | null;
  gateway_response?: string | null;
  paid_at?: string | null;
  metadata?: Record<string, unknown> | null;
  authorization?: Record<string, unknown> | null;
  /** Paystack's internal transaction id. */
  id?: number | null;
  /** True when this payload came from mock mode (no live API call). */
  mock?: boolean;
}

function mockAuthorizationUrl(reference: string): string {
  return `https://checkout.paystack.com/mock/${reference}`;
}

/**
 * Validate a Paystack webhook signature.
 *
 * @param payload   Raw request body — must be the exact bytes Paystack sent.
 * @param signature Value of the X-Paystack-Signature header.
 * @param secret    Paystack secret key (defaults to env).
 */
export function verifyWebhookSignature(
  payload: string,
  signature: string,
  secret: string = paystackSecret(),
): boolean {
  if (!payload || !signature || !secret) return false;
  const computed = createHmac("sha512", secret).update(payload, "utf8").digest("hex");
  const a = Buffer.from(computed, "utf8");
  const b = Buffer.from(signature, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Map a Paystack verify status to our transaction status vocabulary. */
export function mapGatewayStatus(status: string | undefined): "success" | "failed" | "reversed" | "pending" {
  switch (status) {
    case "success":
      return "success";
    case "reversed":
      return "reversed";
    case "abandoned":
    case "failed":
      return "failed";
    default:
      return "failed";
  }
}

async function paystackRequest<T>(
  secret: string,
  method: "GET" | "POST",
  endpoint: string,
  payload?: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(`${PAYSTACK_BASE_URL}${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });

  let body: { status?: boolean; message?: string; data?: T } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    throw new Error(`Paystack error: HTTP ${res.status} with non-JSON body`);
  }

  if (!res.ok) {
    throw new Error(`Paystack error: ${body.message ?? `HTTP ${res.status}`}`);
  }
  if (body.status === false) {
    throw new Error(`Paystack error: ${body.message ?? "Unknown error"}`);
  }
  return body.data as T;
}

/**
 * Initialize a Paystack transaction.
 * Mirrors PaystackService::initializeTransaction() in the Laravel reference.
 */
export async function initializeTransaction(input: InitializeInput): Promise<InitializeResult> {
  if (!input.email) throw new Error("An email address is required.");
  if (!Number.isInteger(input.amountKobo) || input.amountKobo < 10000) {
    throw new Error("Amount must be at least ₦100 (10000 kobo).");
  }
  if (!input.reference) throw new Error("A transaction reference is required.");

  if (isMockMode()) {
    return {
      authorization_url: mockAuthorizationUrl(input.reference),
      access_code: `mock_${input.reference}`,
      reference: input.reference,
    };
  }

  const payload: Record<string, unknown> = {
    email: input.email,
    amount: input.amountKobo,
    reference: input.reference,
    channels: input.channels ?? [...PAYSTACK_CHANNELS],
    currency: PAYSTACK_CURRENCY,
  };
  if (input.callbackUrl) payload.callback_url = input.callbackUrl;
  if (input.metadata && Object.keys(input.metadata).length > 0) {
    payload.metadata = input.metadata;
  }

  return paystackRequest<InitializeResult>(paystackSecret(), "POST", "/transaction/initialize", payload);
}

/**
 * Verify a Paystack transaction by reference.
 * Mirrors PaystackService::verifyTransaction() in the Laravel reference.
 */
export async function verifyTransaction(reference: string): Promise<VerifyResult> {
  if (!reference) throw new Error("A transaction reference is required.");

  if (isMockMode()) {
    return {
      status: "success",
      reference,
      amount: 0,
      channel: "card",
      gateway_response: "Approved (mock)",
      paid_at: new Date().toISOString(),
      metadata: null,
      authorization: null,
      id: null,
      mock: true,
    };
  }

  return paystackRequest<VerifyResult>(
    paystackSecret(),
    "GET",
    `/transaction/verify/${encodeURIComponent(reference)}`,
  );
}
