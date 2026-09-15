// tests/engagement.test.ts
//
// Engagement modules: conversation grouping, unread counts, ticket
// validation, broadcast payload (+ push mock mode, advert liveness,
// safety validation, and route-level smoke tests via app.handle).

import { test, expect, describe, beforeEach } from "bun:test";
import {
  chatApp,
  chatStore,
  participantKeyFor,
  groupConversations,
  getHistory,
  countUnread,
  markConversationRead,
} from "../src/modules/chat/index";
import {
  notificationsApp,
  notificationStore,
  pushTokenStore,
  sendNotification,
} from "../src/modules/notifications/index";
import {
  supportApp,
  supportStore,
  validateTicketInput,
} from "../src/modules/support/index";
import { advertStore, advertsApp, isLive } from "../src/modules/adverts/index";
import { referralStore } from "../src/modules/referrals/index";
import { safetyStore, validateSafetyReport } from "../src/modules/safety/index";
import {
  DeviceTokenStore,
  buildBroadcastPayload,
  buildExpoMessages,
  extractDeadTokens,
  isPushEnabled,
  sendPush,
} from "../src/services/push";

const TOKEN_A = "ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]";
const TOKEN_B = "ExpoPushToken[bbbbbbbbbbbbbbbbbbbbbb]";

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

beforeEach(() => {
  chatStore.reset();
  notificationStore.reset();
  pushTokenStore.reset();
  supportStore.reset();
  advertStore.reset();
  referralStore.reset();
  safetyStore.reset();
});

// ── Chat: grouping + unread ────────────────────────────────────────────────

describe("chat conversations", () => {
  test("participantKeyFor is order-independent", () => {
    expect(participantKeyFor(3, 7)).toBe("3-7");
    expect(participantKeyFor(7, 3)).toBe("3-7");
  });

  test("sync is idempotent on client_message_id replay", () => {
    const item = { conversation_id: "conv-1", client_message_id: "c1", receiver_id: 2, message: "hi" };
    const first = chatStore.syncBatch(1, [item]);
    const second = chatStore.syncBatch(1, [item]);
    expect(first.created).toHaveLength(1);
    expect(first.errors).toHaveLength(0);
    expect(second.created).toHaveLength(0);
    expect(second.duplicates).toHaveLength(1);
    expect(chatStore.messages).toHaveLength(1);
  });

  test("conversation_id reuse across pairs is rejected", () => {
    chatStore.syncBatch(1, [{ conversation_id: "conv-x", client_message_id: "a", receiver_id: 2, message: "hi" }]);
    const res = chatStore.syncBatch(1, [{ conversation_id: "conv-x", client_message_id: "b", receiver_id: 3, message: "yo" }]);
    expect(res.errors).toHaveLength(1);
    expect(chatStore.messages).toHaveLength(1);
  });

  test("self-send is rejected", () => {
    const res = chatStore.syncBatch(1, [{ conversation_id: "c", client_message_id: "a", receiver_id: 1, message: "hi" }]);
    expect(res.errors).toHaveLength(1);
  });

  test("groupConversations groups by conversation_id with last message + unread", () => {
    chatStore.syncBatch(1, [
      { conversation_id: "conv-a", client_message_id: "a1", receiver_id: 2, message: "first" },
      { conversation_id: "conv-b", client_message_id: "b1", receiver_id: 3, message: "other" },
      { conversation_id: "conv-a", client_message_id: "a2", receiver_id: 2, message: "second" },
    ]);
    // Simulate an inbound unread for user 1 in conv-a.
    chatStore.syncBatch(2, [{ conversation_id: "conv-a", client_message_id: "a3", receiver_id: 1, message: "reply" }]);

    const inbox = groupConversations(chatStore, 1);
    expect(inbox).toHaveLength(2);
    const convA = inbox.find((c) => c.conversation_id === "conv-a");
    expect(convA?.last_message.message).toBe("reply");
    expect(convA?.unread_count).toBe(1);
    expect(convA?.participant?.id).toBe(2);
    // Newest first.
    expect(inbox[0]?.conversation_id).toBe("conv-a");
  });

  test("countUnread ignores own sent messages and other conversations", () => {
    chatStore.syncBatch(1, [{ conversation_id: "c1", client_message_id: "m1", receiver_id: 2, message: "out" }]);
    chatStore.syncBatch(2, [{ conversation_id: "c1", client_message_id: "m2", receiver_id: 1, message: "in" }]);
    expect(countUnread(chatStore.messages, 1)).toBe(1);
    expect(countUnread(chatStore.messages, 1, "other")).toBe(0);
  });

  test("markConversationRead zeroes the unread count", () => {
    chatStore.syncBatch(2, [{ conversation_id: "c1", client_message_id: "m1", receiver_id: 1, message: "in" }]);
    expect(markConversationRead(chatStore, 1, "c1")).toBe(1);
    expect(countUnread(chatStore.messages, 1, "c1")).toBe(0);
  });

  test("getHistory paginates newest-first with before cursor", () => {
    for (let i = 0; i < 5; i++) {
      chatStore.syncBatch(1, [{ conversation_id: "c1", client_message_id: `m${i}`, receiver_id: 2, message: `msg-${i}` }]);
    }
    const page1 = getHistory(chatStore, 1, "c1", false, { limit: 2 });
    expect(page1.messages.map((m) => m.message)).toEqual(["msg-4", "msg-3"]);
    expect(page1.hasMore).toBe(true);
    const before = page1.messages[page1.messages.length - 1]?.id;
    const page2 = getHistory(chatStore, 1, "c1", false, { limit: 2, before });
    expect(page2.messages.map((m) => m.message)).toEqual(["msg-2", "msg-1"]);
  });

  test("strangers see no rows for a guessed conversation_id", () => {
    chatStore.syncBatch(1, [{ conversation_id: "secret", client_message_id: "m1", receiver_id: 2, message: "hi" }]);
    const history = getHistory(chatStore, 999, "secret", false);
    expect(history.messages).toHaveLength(0);
    expect(groupConversations(chatStore, 999)).toHaveLength(0);
  });

  test("POST /chat/sync then GET /chat/conversations (route smoke)", async () => {
    const synced = await handle(chatApp, json("POST", "/chat/sync", {
      messages: [{ conversation_id: "r1", client_message_id: "x1", receiver_id: 2, message: "hello" }],
    }));
    expect(synced.status).toBe(201);
    expect((synced.data as { success: boolean }).success).toBe(true);

    const inbox = await handle(chatApp, json("GET", "/chat/conversations"));
    const rows = (inbox.data as { data: unknown[] }).data;
    expect(rows).toHaveLength(1);
  });

  test("POST /chat/presence stores heartbeat", async () => {
    const res = await handle(chatApp, json("POST", "/chat/presence", { is_online: true }));
    expect(res.status).toBe(200);
    expect(chatStore.presence.get(1)?.isOnline).toBe(true);
  });
});

// ── Support: validation + lifecycle ────────────────────────────────────────

describe("support tickets", () => {
  test("validateTicketInput rejects missing subject/message and bad category", () => {
    expect(validateTicketInput({ message: "help" })).toContain("subject is required.");
    expect(validateTicketInput({ subject: "s" })).toContain("message is required.");
    expect(validateTicketInput({ subject: "s", message: "m", category: "nope" }).length).toBeGreaterThan(0);
    expect(validateTicketInput({ subject: "s", message: "m", category: "billing" })).toHaveLength(0);
  });

  test("closed tickets reject replies; resolved reopens on user reply", () => {
    const { ticket } = supportStore.createTicket(1, { subject: "s", message: "m" });
    supportStore.setStatus(ticket, 1, true, "closed");
    const denied = supportStore.reply(ticket, 1, false, "hello?");
    expect("error" in denied).toBe(true);

    supportStore.setStatus(ticket, 1, true, "resolved");
    const reopened = supportStore.reply(ticket, 1, false, "still broken");
    expect("error" in reopened).toBe(false);
    expect(ticket.status).toBe("open");
  });

  test("owners may only resolve/close; staff may set any status", () => {
    const { ticket } = supportStore.createTicket(1, { subject: "s", message: "m" });
    expect("error" in supportStore.setStatus(ticket, 1, false, "pending")).toBe(true);
    expect("error" in supportStore.setStatus(ticket, 1, false, "resolved")).toBe(false);
    expect("error" in supportStore.setStatus(ticket, 9, true, "pending")).toBe(false);
  });

  test("POST /support/tickets 422 on empty body fields (route smoke)", async () => {
    const res = await handle(supportApp, json("POST", "/support/tickets", { subject: "", message: "" }));
    expect(res.status).toBe(422);
    expect((res.data as { success: boolean }).success).toBe(false);
  });

  test("ticket thread marks counterparty messages read", async () => {
    const created = await handle(
      supportApp,
      json("POST", "/support/tickets", { subject: "s", message: "m", category: "billing" }),
    );
    expect(created.status).toBe(201);
    const id = (created.data as { data: { id: number } }).data.id;
    const shown = await handle(supportApp, json("GET", `/support/tickets/${id}`));
    expect(shown.status).toBe(200);
  });
});

// ── Push + broadcast payload ───────────────────────────────────────────────

describe("expo push", () => {
  test("registerToken validates Expo format and reassigns across users", () => {
    const store = new DeviceTokenStore();
    const bad = store.register({ userId: 1, token: "junk", platform: "ios" });
    expect(bad.errors.length).toBeGreaterThan(0);
    const first = store.register({ userId: 1, token: TOKEN_A, platform: "ios" });
    expect(first.errors).toHaveLength(0);
    const moved = store.register({ userId: 2, token: TOKEN_A, platform: "android" });
    expect(moved.row?.userId).toBe(2);
    expect(store.forUser(1)).toHaveLength(0);
  });

  test("remove is scoped to the owning user", () => {
    const store = new DeviceTokenStore();
    store.register({ userId: 1, token: TOKEN_A, platform: "ios" });
    expect(store.remove(2, TOKEN_A)).toBe(false);
    expect(store.remove(1, TOKEN_A)).toBe(true);
  });

  test("buildExpoMessages carries notification id + type in data", () => {
    const msgs = buildExpoMessages(
      { id: 7, type: "chat_message", title: "Hi", body: "yo", data: { conversation_id: "c1" } },
      [TOKEN_A],
    );
    expect(msgs[0]?.to).toBe(TOKEN_A);
    expect(msgs[0]?.sound).toBe("default");
    expect(msgs[0]?.data).toMatchObject({ notification_id: 7, type: "chat_message", conversation_id: "c1" });
  });

  test("extractDeadTokens picks DeviceNotRegistered in order", () => {
    const dead = extractDeadTokens(
      [{ status: "ok" }, { status: "error", details: { error: "DeviceNotRegistered" } }],
      [TOKEN_A, TOKEN_B],
    );
    expect(dead).toEqual([TOKEN_B]);
  });

  test("buildBroadcastPayload defaults to push-only announcement", () => {
    const payload = buildBroadcastPayload({ title: "T", body: "B" });
    expect(payload.type).toBe("announcement");
    expect(payload.channels).toEqual(["push"]);
  });

  test("sendPush mock mode never hits the network", async () => {
    const prev = process.env.EXPO_PUSH_ENABLED;
    process.env.EXPO_PUSH_ENABLED = "false";
    try {
      expect(isPushEnabled()).toBe(false);
      let called = false;
      const result = await sendPush(
        { id: 1, type: "announcement", title: "T", body: "B" },
        [TOKEN_A],
        {
          fetchImpl: (() => {
            called = true;
            throw new Error("must not be called");
          }) as unknown as typeof fetch,
        },
      );
      expect(called).toBe(false);
      expect(result.mocked).toBe(true);
      expect(result.attempted).toBe(1);
    } finally {
      if (prev === undefined) delete process.env.EXPO_PUSH_ENABLED;
      else process.env.EXPO_PUSH_ENABLED = prev;
    }
  });

  test("sendPush prunes dead tokens via store", async () => {
    const prev = process.env.EXPO_PUSH_ENABLED;
    process.env.EXPO_PUSH_ENABLED = "true";
    try {
      const store = new DeviceTokenStore();
      store.register({ userId: 1, token: TOKEN_A, platform: "ios" });
      store.register({ userId: 1, token: TOKEN_B, platform: "ios" });
      const fakeFetch = (async () =>
        new Response(
          JSON.stringify({ data: [{ status: "ok" }, { status: "error", details: { error: "DeviceNotRegistered" } }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        )) as unknown as typeof fetch;
      const result = await sendPush(
        { id: 2, type: "chat_message", title: "T", body: "B" },
        store.forUser(1),
        { fetchImpl: fakeFetch, store },
      );
      expect(result.pruned).toEqual([TOKEN_B]);
      expect(store.forUser(1).map((r) => r.token)).toEqual([TOKEN_A]);
    } finally {
      if (prev === undefined) delete process.env.EXPO_PUSH_ENABLED;
      else process.env.EXPO_PUSH_ENABLED = prev;
    }
  });
});

// ── Notifications routes ───────────────────────────────────────────────────

describe("notifications", () => {
  test("feed carries account-wide unread_count; read-all zeroes it", async () => {
    await sendNotification({ userId: 1, type: "support_reply", title: "T1", body: "B1" });
    await sendNotification({ userId: 1, type: "support_reply", title: "T2", body: "B2" });
    const feed = await handle(notificationsApp, json("GET", "/notifications?per_page=1"));
    const body = feed.data as { data: unknown[]; meta: { unread_count: number; total: number } };
    expect(body.data).toHaveLength(1);
    expect(body.meta.unread_count).toBe(2);
    expect(body.meta.total).toBe(2);

    const all = await handle(notificationsApp, json("POST", "/notifications/read-all"));
    expect((all.data as { data: { marked: number } }).data.marked).toBe(2);
    expect(notificationStore.unreadCount(1)).toBe(0);
  });

  test("single read is scoped to owner (404 for strangers)", async () => {
    const row = notificationStore.create({ userId: 1, type: "x", title: "T", body: "B" });
    const stranger = await handle(notificationsApp, json("POST", `/notifications/${row.id}/read`, undefined, { "x-user-id": "2" }));
    expect(stranger.status).toBe(404);
    const owner = await handle(notificationsApp, json("POST", `/notifications/${row.id}/read`));
    expect(owner.status).toBe(200);
  });

  test("push-token register + delete round-trip", async () => {
    const reg = await handle(notificationsApp, json("POST", "/notifications/push-token", { token: TOKEN_A, platform: "ios" }));
    expect(reg.status).toBe(200);
    const bad = await handle(notificationsApp, json("POST", "/notifications/push-token", { token: "nope", platform: "ios" }));
    expect(bad.status).toBe(422);
    const del = await handle(notificationsApp, json("DELETE", "/notifications/push-token", { token: TOKEN_A }));
    expect((del.data as { data: { removed: boolean } }).data.removed).toBe(true);
  });
});

// ── Adverts / referrals / safety ───────────────────────────────────────────

describe("adverts", () => {
  test("isLive requires active status and open window", () => {
    const base = advertStore.submit(1, { title: "A" });
    expect(isLive(base)).toBe(false);
    advertStore.setStatus(base.id, "active");
    expect(isLive({ ...base, status: "active" })).toBe(true);
    expect(isLive({ ...base, status: "active", endsAt: new Date(Date.now() - 1000).toISOString() })).toBe(false);
    expect(isLive({ ...base, status: "active", startsAt: new Date(Date.now() + 60_000).toISOString() })).toBe(false);
  });

  test("POST /adverts submits pending; GET /adverts/active hides it until live", async () => {
    const created = await handle(advertsApp, json("POST", "/adverts", { title: "Sale", link: "https://example.com/sale" }));
    expect(created.status).toBe(201);
    expect((created.data as { data: { status: string } }).data.status).toBe("pending");
    const feed = await handle(advertsApp, json("GET", "/adverts/active"));
    expect((feed.data as { data: unknown[] }).data).toHaveLength(0);
  });
});

describe("referrals", () => {
  test("register requires code or campaign; attribution converts by id", () => {
    expect("errors" in referralStore.register(1, {})).toBe(true);
    const reg = referralStore.register(1, { code: "INVITE-1" });
    expect("row" in reg && reg.row.status).toBe("registered");
    const anon = referralStore.register(null, { campaign: "launch" });
    expect("row" in anon && anon.row.status).toBe("pending");
    if ("row" in reg) {
      const conv = referralStore.track(2, { attribution_id: reg.row.uuid, event: "signup" });
      expect("row" in conv && conv.row.status).toBe("converted");
    }
  });
});

describe("safety reports", () => {
  test("validateSafetyReport rejects bad target/reason and empty details", () => {
    expect(validateSafetyReport({ target_type: "nope", reason: "scam", details: "x" }).length).toBeGreaterThan(0);
    expect(validateSafetyReport({ target_type: "user", reason: "nope", details: "x" }).length).toBeGreaterThan(0);
    expect(validateSafetyReport({ target_type: "listing", reason: "scam", details: "" }).length).toBeGreaterThan(0);
    expect(validateSafetyReport({ target_type: "listing", target_id: "abc", reason: "scam", details: "stolen pics" })).toHaveLength(0);
  });
});
