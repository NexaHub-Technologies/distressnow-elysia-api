// tests/broadcast.test.ts
//
// Broadcast fan-out: the dispatch orchestrator (services/broadcast) with
// fake senders, plus the memory queue seams (resolveRecipientIds /
// updateStatus / contacts) over a seeded AdminStore.

import { test, expect, describe } from "bun:test";
import {
  BROADCAST_SEND_CONCURRENCY,
  dispatchBroadcast,
  runWithConcurrency,
  type BroadcastDispatchDeps,
} from "../src/services/broadcast";
import {
  AdminStore,
  MemoryBroadcastsAdminQueue,
  MemoryUsersAdminQueue,
  type AdminManagedUser,
  type BroadcastItem,
} from "../src/modules/admin/index";
import { nowIso } from "../src/utils/phone";

function deps(overrides: Partial<BroadcastDispatchDeps> = {}): BroadcastDispatchDeps {
  return {
    recipientIds: ["u1", "u2"],
    tokensForUsers: async () => [],
    contactsForUsers: async () => [],
    ...overrides,
  };
}

describe("runWithConcurrency", () => {
  test("bounds parallelism and accounts sent/failed", async () => {
    let inflight = 0;
    let peak = 0;
    const result = await runWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => {
      inflight++;
      peak = Math.max(peak, inflight);
      await new Promise((r) => setTimeout(r, 5));
      inflight--;
      if (n === 4) throw new Error("boom");
    });
    expect(peak).toBeLessThanOrEqual(2);
    expect(result).toEqual({ sent: 4, failed: 1 });
    expect(BROADCAST_SEND_CONCURRENCY).toBeGreaterThanOrEqual(1);
  });
});

describe("dispatchBroadcast", () => {
  test("push fans out to deduped tokens in one sender call", async () => {
    const calls: Array<{ n: { title: string; body: string; type: string }; tokens: string[] }> = [];
    const result = await dispatchBroadcast(
      { title: "Hello", body: "World", type: "announcement" },
      ["push"],
      deps({
        recipientIds: ["u1", "u2", "u1"],
        tokensForUsers: async (ids) => (ids.includes("u1") ? ["t1", "t2", "t1"] : ["t3"]),
        pushSender: {
          send: async (n, tokens) => {
            calls.push({ n, tokens });
            return { sent: tokens.length };
          },
        },
      }),
    );
    expect(calls.length).toBe(1);
    expect(calls[0]?.tokens).toEqual(["t1", "t2"]);
    expect(calls[0]?.n).toEqual({ title: "Hello", body: "World", type: "announcement" });
    expect(result.channels).toEqual([
      { channel: "push", attempted: 2, sent: 2, failed: 0 },
    ]);
    expect(result.sentCount).toBe(2);
    expect(result.failureReason).toBeNull();
  });

  test("push sender failure is recorded, not thrown", async () => {
    const result = await dispatchBroadcast(
      { title: "Hi", body: "There" },
      ["push"],
      deps({
        tokensForUsers: async () => ["t1", "t2"],
        pushSender: {
          send: async () => {
            throw new Error("expo down");
          },
        },
      }),
    );
    expect(result.sentCount).toBe(0);
    expect(result.channels[0]).toMatchObject({ channel: "push", attempted: 2, sent: 0, failed: 2 });
    expect(result.failureReason).toContain("push");
    expect(result.failureReason).toContain("expo down");
  });

  test("sms skips contacts without phones and formats the message", async () => {
    const sent: Array<{ phone: string; message: string }> = [];
    const result = await dispatchBroadcast(
      { title: "Sale", body: "50% off" },
      ["sms"],
      deps({
        contactsForUsers: async () => [
          { userId: "u1", phone: "+2348011111111", email: null },
          { userId: "u2", phone: null, email: "u2@example.com" },
        ],
        smsSender: {
          send: async (phone, message) => {
            sent.push({ phone, message });
          },
        },
      }),
    );
    expect(sent).toEqual([{ phone: "+2348011111111", message: "Sale\n\n50% off" }]);
    expect(result.channels).toEqual([{ channel: "sms", attempted: 1, sent: 1, failed: 0 }]);
    expect(result.sentCount).toBe(1);
  });

  test("email skips contacts without emails; partial failures roll up", async () => {
    const result = await dispatchBroadcast(
      { title: "News", body: "Hello" },
      ["email", "push"],
      deps({
        contactsForUsers: async () => [
          { userId: "u1", phone: null, email: "ok@example.com" },
          { userId: "u2", phone: null, email: "bad@example.com" },
        ],
        emailSender: {
          send: async (to) => {
            if (to.startsWith("bad")) throw new Error("bounce");
          },
        },
      }),
    );
    const email = result.channels.find((c) => c.channel === "email");
    expect(email).toMatchObject({ attempted: 2, sent: 1, failed: 1 });
    // push had no tokens and no sender activity — still reported for honesty.
    expect(result.channels.find((c) => c.channel === "push")).toBeUndefined();
    expect(result.sentCount).toBe(1);
    expect(result.failureReason).toContain("email: 1/2 failed");
  });

  test("no reachable contacts yields zero sends and no failure", async () => {
    const result = await dispatchBroadcast(
      { title: "T", body: "B" },
      ["push", "sms"],
      deps({
        pushSender: { send: async () => ({ sent: 0 }) },
        smsSender: { send: async () => {} },
      }),
    );
    expect(result.sentCount).toBe(0);
    expect(result.failureReason).toBeNull();
    expect(result.channels).toEqual([
      { channel: "push", attempted: 0, sent: 0, failed: 0 },
      { channel: "sms", attempted: 0, sent: 0, failed: 0 },
    ]);
  });

  test("channels without a wired sender are skipped", async () => {
    const result = await dispatchBroadcast({ title: "T", body: "B" }, ["push", "sms"], deps());
    expect(result.channels).toEqual([]);
    expect(result.sentCount).toBe(0);
    expect(result.failureReason).toBeNull();
  });
});

describe("memory broadcast/user seams", () => {
  function seedStore(): AdminStore {
    const store = new AdminStore();
    const mk = (id: string, roles: string[], extra?: Partial<AdminManagedUser>): AdminManagedUser => ({
      id,
      name: `User ${id}`,
      email: `${id}@example.com`,
      roles,
      state: "Lagos",
      isSuspended: false,
      suspensionReason: null,
      createdAt: nowIso(),
      ...extra,
    });
    store.users.set("u1", mk("u1", ["buyer"], { phone: "+2348011111111", createdAt: "2026-01-03T00:00:00.000Z" }));
    store.users.set("u2", mk("u2", ["admin"], { createdAt: "2026-01-02T00:00:00.000Z" }));
    store.users.set("u3", mk("u3", ["buyer"], { isSuspended: true, createdAt: "2026-01-04T00:00:00.000Z" }));
    return store;
  }

  test("resolveRecipientIds filters by audience, skips suspended, honors limit", () => {
    const store = seedStore();
    const q = new MemoryBroadcastsAdminQueue(store);
    expect(q.resolveRecipientIds("all")).toEqual(["u1", "u2"]);
    expect(q.resolveRecipientIds("role", "admin")).toEqual(["u2"]);
    expect(q.resolveRecipientIds("role", "buyer")).toEqual(["u1"]);
    expect(q.resolveRecipientIds("users", undefined, undefined, ["u2", "nope", "u3"])).toEqual(["u2"]);
    expect(q.resolveRecipientIds("all", undefined, undefined, undefined, 1)).toEqual(["u1"]);
    expect(q.resolveRecipientIds("state", undefined, "Kano")).toEqual([]);
  });

  test("updateStatus patches the shared broadcast row", () => {
    const store = seedStore();
    const q = new MemoryBroadcastsAdminQueue(store);
    const item: BroadcastItem = {
      id: "b1", adminId: "u2", audience: "all", title: "T", body: "B",
      type: "announcement", channels: ["push"], recipientCount: 2, status: "queued",
      sentCount: 0, failureReason: null, startedAt: null, completedAt: null, createdAt: nowIso(),
    };
    q.create(item);
    const updated = q.updateStatus("b1", { status: "sent", sentCount: 2, completedAt: nowIso() });
    expect(updated?.status).toBe("sent");
    expect(store.broadcasts[0]?.sentCount).toBe(2);
    expect(q.updateStatus("missing", { status: "failed" })).toBeNull();
  });

  test("contacts returns phone/email pairs for the requested ids", () => {
    const store = seedStore();
    const q = new MemoryUsersAdminQueue(store.users);
    expect(q.contacts(["u1", "u2", "nope"])).toEqual([
      { userId: "u1", phone: "+2348011111111", email: "u1@example.com" },
      { userId: "u2", phone: null, email: "u2@example.com" },
    ]);
  });
});
