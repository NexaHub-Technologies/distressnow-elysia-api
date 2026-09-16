/**
 * Payments module — Elysia plugin, prefix /api/v1/payments.
 *
 * Port of the Laravel reference:
 *   DistressNowApi/app/Http/Controllers/Api/V1/PaymentController.php
 *
 *  - POST /initialize — auth — create a transaction + Paystack auth URL
 *  - POST /verify     — auth — verify a transaction by reference
 *  - POST /webhook    — public — Paystack charge.success handler (HMAC verified)
 *
 * All responses use the envelope { success, message, data } (same shape as
 * the auth module; ok()/fail() are defined locally to keep this module
 * self-contained).
 *
 * Auth: applyOptionalAuth resolves the JWT bearer (shared UserStore); the
 * routes that need a caller (initialize/verify) reject with 401 when no user
 * is present, while the webhook stays public and relies on Paystack's HMAC
 * signature instead.
 *
 * Persistence: in-memory TransactionStore behind a small interface.
 * Production uses the drizzle-backed overlay (createDbTransactionStore over
 * `transactions`) unless an explicit store is injected (tests).
 * over the `transactions` table (reference, user_id, booking_id, amount,
 * amount_kobo, status, channel, gateway_response, authorization, metadata,
 * paid_at) — no route code needs to change.
 */
import { Elysia, t } from "elysia";
import {
  initializeTransaction,
  isGatewayDisabled,
  mapGatewayStatus,
  verifyTransaction,
  verifyWebhookSignature,
} from "../../services/paystack";
import { applyOptionalAuth, type UserStore } from "../auth/index";
import { getDbStores } from "../../db/stores";
import { newId, nowIso } from "../../utils/phone";

// ── Envelope ─────────────────────────────────────────────────────────────────

export function ok<T>(message: string, data: T): {
  success: true;
  message: string;
  data: T;
} {
  return { success: true, message, data };
}

export function fail(message: string): {
  success: false;
  message: string;
  data: null;
} {
  return { success: false, message, data: null };
}

// ── Transaction store ────────────────────────────────────────────────────────

export type TransactionStatus = "pending" | "success" | "failed" | "reversed";

export interface TransactionRecord {
  id: string;
  uuid: string;
  userId: string;
  bookingId: string | null;
  reference: string;
  amount: number;
  amountKobo: number;
  status: TransactionStatus;
  channel: string | null;
  gatewayResponse: string | null;
  authorization: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  paidAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTransactionInput {
  userId: string;
  bookingId?: string | null;
  reference: string;
  amount: number;
  amountKobo: number;
  metadata?: Record<string, unknown> | null;
}

export interface TransactionStore {
  findByReference(reference: string): TransactionRecord | null | Promise<TransactionRecord | null>;
  create(input: CreateTransactionInput): TransactionRecord | Promise<TransactionRecord>;
  update(
    reference: string,
    patch: Partial<TransactionRecord>,
  ): TransactionRecord | null | Promise<TransactionRecord | null>;
  reset(): void | Promise<void>;
}

export class MemoryTransactionStore implements TransactionStore {
  private byReference = new Map<string, TransactionRecord>();

  findByReference(reference: string): TransactionRecord | null {
    return this.byReference.get(reference) ?? null;
  }

  create(input: CreateTransactionInput): TransactionRecord {
    const now = nowIso();
    const record: TransactionRecord = {
      id: newId("txn"),
      uuid: crypto.randomUUID(),
      userId: input.userId,
      bookingId: input.bookingId ?? null,
      reference: input.reference,
      amount: input.amount,
      amountKobo: input.amountKobo,
      status: "pending",
      channel: null,
      gatewayResponse: null,
      authorization: null,
      metadata: input.metadata ?? null,
      paidAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.byReference.set(record.reference, record);
    return record;
  }

  update(reference: string, patch: Partial<TransactionRecord>): TransactionRecord | null {
    const existing = this.byReference.get(reference);
    if (!existing) return null;
    const updated: TransactionRecord = {
      ...existing,
      ...patch,
      id: existing.id,
      uuid: existing.uuid,
      reference: existing.reference,
      updatedAt: nowIso(),
    };
    this.byReference.set(reference, updated);
    return updated;
  }

  reset(): void {
    this.byReference.clear();
  }
}

/** Default singleton (override via plugin options in tests). */
export const transactionStore = new MemoryTransactionStore();

export interface SerializedTransaction {
  reference: string;
  amount: number;
  amount_kobo: number;
  status: TransactionStatus;
  channel: string | null;
  gateway_response: string | null;
  paid_at: string | null;
  metadata: Record<string, unknown> | null;
}

export function serializeTransaction(record: TransactionRecord): SerializedTransaction {
  return {
    reference: record.reference,
    amount: record.amount,
    amount_kobo: record.amountKobo,
    status: record.status,
    channel: record.channel,
    gateway_response: record.gatewayResponse,
    paid_at: record.paidAt,
    metadata: record.metadata,
  };
}

/** Generate a Paystack reference like the Laravel controller: TXN- + 20 chars. */
export function generateReference(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  let suffix = "";
  for (const byte of bytes) suffix += alphabet[(byte as number) % alphabet.length];
  return `TXN-${suffix}`;
}

// ── Schemas ──────────────────────────────────────────────────────────────────

const InitializeBody = t.Object({
  /** Amount in naira — minimum ₦100 (mirrors the Laravel validator). */
  amount: t.Number({ minimum: 100 }),
  booking_id: t.Optional(t.String({ maxLength: 64 })),
  metadata: t.Optional(t.Record(t.String(), t.Unknown())),
  callback_url: t.Optional(t.String({ maxLength: 2048 })),
});

const VerifyBody = t.Object({
  reference: t.String({ minLength: 1, maxLength: 128 }),
});

// ── Plugin ───────────────────────────────────────────────────────────────────

export interface PaymentsPluginOptions {
  store?: TransactionStore;
  users?: UserStore;
  secret?: string;
}

export function createPaymentsPlugin(options: PaymentsPluginOptions = {}) {
  const store = options.store ?? getDbStores()?.transactions ?? transactionStore;

  return applyOptionalAuth(new Elysia({ prefix: "/api/v1/payments" }), {
    secret: options.secret,
    users: options.users ?? getDbStores()?.users,
  })
    .post(
      "/initialize",
      async ({ body, currentUser, status }) => {
        if (!currentUser) return status(401, fail("Unauthenticated."));
        // Fail closed: never hand out mock checkout URLs in production.
        if (isGatewayDisabled()) {
          return status(503, fail("Payment gateway is not configured."));
        }
        const user = currentUser;
        const userEmail = user.email ?? `${user.id}@example.com`;

        const amountKobo = Math.round(body.amount * 100);
        const reference = generateReference();

        const transaction = await store.create({
          userId: user.id,
          bookingId: body.booking_id ?? null,
          reference,
          amount: body.amount,
          amountKobo,
          metadata: (body.metadata as Record<string, unknown> | undefined) ?? null,
        });

        try {
          const paystack = await initializeTransaction({
            email: userEmail,
            amountKobo,
            reference,
            callbackUrl: body.callback_url,
            metadata: {
              ...((body.metadata as Record<string, unknown> | undefined) ?? {}),
              user_id: user.id,
              transaction_id: transaction.uuid,
            },
          });

          return status(201, ok("Payment initialized successfully.", {
            authorization_url: paystack.authorization_url,
            access_code: paystack.access_code,
            reference: paystack.reference,
            transaction: serializeTransaction(transaction),
          }));
        } catch (err) {
          await store.update(reference, {
            status: "failed",
            gatewayResponse: (err as Error).message,
          });
          return status(502, fail(`Payment initialization failed: ${(err as Error).message}`));
        }
      },
      { body: InitializeBody },
    )

    .post(
      "/verify",
      async ({ body, currentUser, status }) => {
        if (!currentUser) return status(401, fail("Unauthenticated."));
        // Fail closed: mock verifications must never confirm payments in production.
        if (isGatewayDisabled()) {
          return status(503, fail("Payment gateway is not configured."));
        }

        const transaction = await store.findByReference(body.reference);
        if (!transaction) return status(404, fail("Transaction not found."));

        if (transaction.status !== "pending") {
          return ok("Transaction already processed.", {
            transaction: serializeTransaction(transaction),
          });
        }

        try {
          const data = await verifyTransaction(body.reference);
          const mapped = mapGatewayStatus(data.status);

          const updated = await store.update(body.reference, {
            status: mapped,
            channel: (data.channel as string | null | undefined) ?? null,
            gatewayResponse: (data.gateway_response as string | null | undefined) ?? null,
            authorization: (data.authorization as Record<string, unknown> | null | undefined) ?? null,
            paidAt: (data.paid_at as string | null | undefined) ?? null,
            metadata:
              (data.metadata as Record<string, unknown> | null | undefined) ?? transaction.metadata,
          }) as TransactionRecord;

          return ok(
            mapped === "success" ? "Payment successful." : `Payment ${mapped}.`,
            { transaction: serializeTransaction(updated) },
          );
        } catch (err) {
          return status(502, fail(`Verification failed: ${(err as Error).message}`));
        }
      },
      { body: VerifyBody },
    )

    .post("/webhook", async ({ body, headers, status }) => {
      // Raw text body is required: the HMAC must cover the exact bytes
      // Paystack sent (see `parse: "text"` below).
      const rawText = typeof body === "string" ? body : JSON.stringify(body ?? "");
      const header = headers["x-paystack-signature"];
      const signature = (Array.isArray(header) ? header[0] : header) ?? "";

      if (!verifyWebhookSignature(rawText, signature)) {
        return status(401, fail("Invalid signature."));
      }

      let event: { event?: string; data?: Record<string, unknown> };
      try {
        event = JSON.parse(rawText) as typeof event;
      } catch {
        return status(422, fail("Invalid webhook payload."));
      }

      if (event.event === "charge.success") {
        const reference =
          typeof event.data?.reference === "string" ? event.data.reference : null;
        if (reference) {
          const transaction = await store.findByReference(reference);
          if (transaction && transaction.status === "pending") {
            await store.update(reference, {
              status: "success",
              channel: typeof event.data?.channel === "string" ? event.data.channel : null,
              gatewayResponse:
                typeof event.data?.gateway_response === "string"
                  ? event.data.gateway_response
                  : null,
              authorization:
                (event.data?.authorization as Record<string, unknown> | undefined) ?? null,
              paidAt:
                typeof event.data?.paid_at === "string" ? event.data.paid_at : nowIso(),
            });
          }
        }
      }

      return ok("Webhook processed.", null);
    }, { parse: "text" });
}

/** Default singleton plugin (uses the shared in-memory transaction store). */
export const paymentsApp = createPaymentsPlugin();
