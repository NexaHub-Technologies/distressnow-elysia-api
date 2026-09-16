/**
 * Broadcast fan-out orchestration (push / SMS / email).
 *
 * Pure orchestration with injected senders — no direct imports of the Expo,
 * Termii, or Resend clients, so tests drive it with fakes and the admin
 * route wires the real senders. Every sender call is individually guarded:
 * one dead token or bad address never fails the batch, and per-channel
 * counts roll up into the broadcast lifecycle row.
 *
 * Scale notes:
 *  - push goes through sendPush, which already chunks at EXPO_CHUNK_SIZE
 *    (100) and prunes dead tokens — one HTTPS call per chunk.
 *  - SMS/email have no provider bulk endpoint here, so they run through a
 *    bounded worker pool (BROADCAST_SEND_CONCURRENCY) instead of N
 *    sequential or unbounded-parallel requests.
 *  - callers must cap the audience BEFORE dispatch (the admin route 422s
 *    above BROADCAST_DISPATCH_CAP / SMS_RECIPIENT_CAP); the orchestrator
 *    trusts the ids it is given.
 */

/** Hard cap on push/email recipients per broadcast (admin route enforces). */
export const BROADCAST_DISPATCH_CAP = 5000;

/** Bounded parallelism for the per-recipient SMS/email loops. */
export const BROADCAST_SEND_CONCURRENCY = 10;

export interface BroadcastContent {
  title: string;
  body: string;
  type?: string;
}

export interface BroadcastContact {
  userId: string;
  phone: string | null;
  email: string | null;
}

export interface BroadcastDispatchDeps {
  recipientIds: string[];
  tokensForUsers(ids: string[]): Promise<string[]> | string[];
  contactsForUsers(ids: string[]): Promise<BroadcastContact[]> | BroadcastContact[];
  /**
   * Push fan-out over the resolved tokens (admin wires sendPush, which
   * chunks at EXPO_CHUNK_SIZE and prunes dead tokens).
   */
  pushSender?: {
    send(
      notification: { title: string; body: string; type: string },
      tokens: string[],
    ): Promise<{ sent: number }>;
  };
  smsSender?: {
    send(phone: string, message: string): Promise<unknown>;
  };
  emailSender?: {
    send(to: string, subject: string, body: string): Promise<unknown>;
  };
}

export interface BroadcastChannelResult {
  channel: "push" | "sms" | "email";
  attempted: number;
  sent: number;
  failed: number;
  error?: string;
}

export interface BroadcastDispatchResult {
  channels: BroadcastChannelResult[];
  sentCount: number;
  failureReason: string | null;
}

/** Bounded worker pool: at most `limit` fn() in flight at once. */
export async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<unknown>,
): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;
  let cursor = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      while (cursor < items.length) {
        const item = items[cursor++] as T;
        try {
          await fn(item);
          sent++;
        } catch {
          failed++;
        }
      }
    },
  );
  await Promise.all(workers);
  return { sent, failed };
}

export async function dispatchBroadcast(
  content: BroadcastContent,
  channels: string[],
  deps: BroadcastDispatchDeps,
): Promise<BroadcastDispatchResult> {
  const results: BroadcastChannelResult[] = [];

  if (channels.includes("push") && deps.pushSender) {
    const tokens = [...new Set(await deps.tokensForUsers(deps.recipientIds))].filter(Boolean);
    if (tokens.length === 0) {
      results.push({ channel: "push", attempted: 0, sent: 0, failed: 0 });
    } else {
      try {
        const { sent } = await deps.pushSender.send(
          { title: content.title, body: content.body, type: content.type ?? "announcement" },
          tokens,
        );
        results.push({
          channel: "push",
          attempted: tokens.length,
          sent,
          failed: Math.max(0, tokens.length - sent),
        });
      } catch (err) {
        results.push({
          channel: "push",
          attempted: tokens.length,
          sent: 0,
          failed: tokens.length,
          error: (err as Error).message,
        });
      }
    }
  }

  if (channels.includes("sms") && deps.smsSender) {
    const sender = deps.smsSender;
    const contacts = (await deps.contactsForUsers(deps.recipientIds)).filter(
      (c) => c.phone && c.phone.trim().length > 0,
    );
    const message = `${content.title}\n\n${content.body}`;
    const { sent, failed } = await runWithConcurrency(
      contacts,
      BROADCAST_SEND_CONCURRENCY,
      (c) => sender.send(c.phone as string, message),
    );
    results.push({ channel: "sms", attempted: contacts.length, sent, failed });
  }

  if (channels.includes("email") && deps.emailSender) {
    const sender = deps.emailSender;
    const contacts = (await deps.contactsForUsers(deps.recipientIds)).filter(
      (c) => c.email && c.email.trim().length > 0,
    );
    const { sent, failed } = await runWithConcurrency(
      contacts,
      BROADCAST_SEND_CONCURRENCY,
      (c) => sender.send(c.email as string, content.title, content.body),
    );
    results.push({ channel: "email", attempted: contacts.length, sent, failed });
  }

  const sentCount = results.reduce((sum, r) => sum + r.sent, 0);
  const problems = results.filter((r) => r.failed > 0 || r.error);
  return {
    channels: results,
    sentCount,
    failureReason:
      problems.length > 0
        ? problems
            .map((r) => `${r.channel}: ${r.failed}/${r.attempted} failed${r.error ? ` (${r.error})` : ""}`)
            .join("; ")
        : null,
  };
}
