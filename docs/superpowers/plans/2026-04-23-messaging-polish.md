# Messaging Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship reactions, typing indicators, and per-channel unread counts on top of Messaging core + Billing plans, following [docs/superpowers/specs/2026-04-23-messaging-polish-design.md](../specs/2026-04-23-messaging-polish-design.md).

**Architecture:** Three independent additive sub-systems. Each gets its own Convex table (`reactions`, `typingIndicators`, `channelReadStates`), its own module (`reactions.ts`, `typing.ts`, `reads.ts`), and its own client surface. `messages.list` is untouched on the hot path; `channels.listMine` is extended to embed per-channel `unreadCount`. Cascades wired through `channels.deleteChannel` and `clerkSync.deleteMembership`.

**Tech Stack:** Next.js 16 App Router, React 19, Convex 1.35.1, `convex-test`, `vitest`, `@clerk/nextjs` 6.39.1, Tailwind 4. No new dependencies.

---

## Pre-flight check

- [ ] On branch `messaging-polish` (off master). Run `git status` — only clean working tree except the pre-existing `slack-b2b-app/convex/_generated/api.d.ts` drift from before (leave alone; Convex regenerates it).
- [ ] `cd slack-b2b-app && npm install` completes clean.
- [ ] `npm run test` passes (75/75 from Billing plans).
- [ ] `npm run build` clean.
- [ ] `npx convex dev` running in a side terminal during implementation so type generation stays current.
- [ ] Two Clerk test users + one test workspace ready for manual E2E at the end.

---

## File structure after Messaging polish

```
slack-b2b-app/
├── app/
│   └── [slug]/
│       └── channels/
│           └── [channel]/
│               └── page.tsx                     ← modified (mount <TypingBar>)
├── components/
│   └── messaging/
│       ├── ReactionBar.tsx                      ← created
│       ├── TypingBar.tsx                        ← created
│       ├── MessageRow.tsx                       ← modified (reactions slot)
│       ├── MessageList.tsx                      ← modified (reactions subscription + mark-read)
│       ├── MessageComposer.tsx                  ← modified (typing hook wiring)
│       └── WorkspaceSidebar.tsx                 ← modified (unread badge + bold)
├── hooks/
│   ├── useTypingHeartbeat.ts                    ← created
│   └── useMarkChannelRead.ts                    ← created
└── convex/
    ├── schema.ts                                ← modified (+3 tables)
    ├── reactions.ts                             ← created
    ├── reactions.test.ts                        ← created
    ├── typing.ts                                ← created
    ├── typing.test.ts                           ← created
    ├── reads.ts                                 ← created
    ├── reads.test.ts                            ← created
    ├── channels.ts                              ← modified (listMine embeds unreadCount; deleteChannel cascades 3 tables)
    ├── channels.test.ts                         ← modified (unread + cascade tests)
    ├── clerkSync.ts                             ← modified (deleteMembership cascades 3 tables)
    └── clerkSync.test.ts                        ← modified (cascade tests)
```

---

## Task 1: Add the three schema tables

**Files:**
- Modify: `slack-b2b-app/convex/schema.ts`

- [ ] **Step 1: Open `convex/schema.ts` and append three table definitions** before the closing `});`. Place them after `messages:`.

```typescript
reactions: defineTable({
  messageId: v.id("messages"),
  userId: v.id("users"),
  emoji: v.string(),
  channelId: v.id("channels"),
})
  .index("by_message", ["messageId"])
  .index("by_message_user_emoji", ["messageId", "userId", "emoji"])
  .index("by_channel", ["channelId"])
  .index("by_user_and_channel", ["userId", "channelId"]),

typingIndicators: defineTable({
  channelId: v.id("channels"),
  userId: v.id("users"),
  organizationId: v.id("organizations"),
  expiresAt: v.number(),
})
  .index("by_channel", ["channelId"])
  .index("by_channel_and_user", ["channelId", "userId"])
  .index("by_user_and_organization", ["userId", "organizationId"]),

channelReadStates: defineTable({
  userId: v.id("users"),
  channelId: v.id("channels"),
  organizationId: v.id("organizations"),
  lastReadAt: v.number(),
})
  .index("by_user_and_channel", ["userId", "channelId"])
  .index("by_user_and_organization", ["userId", "organizationId"])
  .index("by_channel", ["channelId"]),
```

- [ ] **Step 2: Push the schema to the dev deployment.**

In the terminal that's running `npx convex dev`, watch for `Schema validation passed`. If errors, fix the schema file and repeat.

- [ ] **Step 3: Verify tests still pass.**

Run: `npm run test`
Expected: 75/75 tests PASS (no behavioral change yet; adding empty tables is non-breaking).

- [ ] **Step 4: Commit.**

```bash
git add slack-b2b-app/convex/schema.ts
git commit -m "schema: add reactions, typingIndicators, channelReadStates tables"
```

---

## Task 2: `convex/reactions.ts` — `toggle` mutation

**Files:**
- Create: `slack-b2b-app/convex/reactions.ts`
- Create: `slack-b2b-app/convex/reactions.test.ts`

- [ ] **Step 1: Create `convex/reactions.test.ts` with the `toggle` test cases.**

```typescript
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const ISSUER = "https://awaited-boxer-54.clerk.accounts.dev";
const TOKEN_ALICE = `${ISSUER}|user_alice`;
const TOKEN_BOB = `${ISSUER}|user_bob`;

async function seedChannelWithTwoMembersAndMessage(
  t: ReturnType<typeof convexTest>,
) {
  return await t.run(async (ctx) => {
    const aliceId = await ctx.db.insert("users", {
      clerkUserId: "user_alice",
      tokenIdentifier: TOKEN_ALICE,
      email: "alice@example.com",
      name: "Alice",
    });
    const bobId = await ctx.db.insert("users", {
      clerkUserId: "user_bob",
      tokenIdentifier: TOKEN_BOB,
      email: "bob@example.com",
      name: "Bob",
    });
    const orgId = await ctx.db.insert("organizations", {
      clerkOrgId: "org_1",
      slug: "acme",
      name: "Acme",
    });
    await ctx.db.insert("memberships", {
      userId: aliceId,
      organizationId: orgId,
      clerkMembershipId: "m_a",
      role: "org:admin",
    });
    await ctx.db.insert("memberships", {
      userId: bobId,
      organizationId: orgId,
      clerkMembershipId: "m_b",
      role: "org:member",
    });
    const channelId = await ctx.db.insert("channels", {
      organizationId: orgId,
      slug: "general",
      name: "General",
      createdBy: aliceId,
      isProtected: true,
    });
    await ctx.db.insert("channelMembers", {
      channelId,
      userId: aliceId,
      organizationId: orgId,
    });
    await ctx.db.insert("channelMembers", {
      channelId,
      userId: bobId,
      organizationId: orgId,
    });
    const messageId = await ctx.db.insert("messages", {
      channelId,
      userId: bobId,
      text: "hello",
    });
    return { aliceId, bobId, orgId, channelId, messageId };
  });
}

const asAlice = (t: ReturnType<typeof convexTest>) =>
  t.withIdentity({ tokenIdentifier: TOKEN_ALICE, subject: "user_alice", email: "alice@example.com" });

test("reactions.toggle inserts a reaction for a valid emoji", async () => {
  const t = convexTest(schema, modules);
  const { messageId } = await seedChannelWithTwoMembersAndMessage(t);
  await asAlice(t).mutation(api.reactions.toggle, { messageId, emoji: "👍" });
  const rows = await t.run(async (ctx) =>
    await ctx.db.query("reactions").withIndex("by_message", (q) => q.eq("messageId", messageId)).collect(),
  );
  expect(rows).toHaveLength(1);
  expect(rows[0].emoji).toBe("👍");
});

test("reactions.toggle twice with same args removes the row", async () => {
  const t = convexTest(schema, modules);
  const { messageId } = await seedChannelWithTwoMembersAndMessage(t);
  await asAlice(t).mutation(api.reactions.toggle, { messageId, emoji: "👍" });
  await asAlice(t).mutation(api.reactions.toggle, { messageId, emoji: "👍" });
  const rows = await t.run(async (ctx) =>
    await ctx.db.query("reactions").withIndex("by_message", (q) => q.eq("messageId", messageId)).collect(),
  );
  expect(rows).toHaveLength(0);
});

test("reactions.toggle rejects disallowed emoji", async () => {
  const t = convexTest(schema, modules);
  const { messageId } = await seedChannelWithTwoMembersAndMessage(t);
  await expect(
    asAlice(t).mutation(api.reactions.toggle, { messageId, emoji: "🦄" }),
  ).rejects.toThrow(/not allowed/i);
});

test("reactions.toggle rejects a tombstoned message", async () => {
  const t = convexTest(schema, modules);
  const { messageId } = await seedChannelWithTwoMembersAndMessage(t);
  await t.run(async (ctx) => await ctx.db.patch(messageId, { deletedAt: Date.now() }));
  await expect(
    asAlice(t).mutation(api.reactions.toggle, { messageId, emoji: "👍" }),
  ).rejects.toThrow(/deleted/i);
});

test("reactions.toggle rejects non-channel-member", async () => {
  const t = convexTest(schema, modules);
  const { messageId } = await seedChannelWithTwoMembersAndMessage(t);
  const outsiderToken = `${ISSUER}|user_outsider`;
  await t.run(async (ctx) =>
    await ctx.db.insert("users", {
      clerkUserId: "user_outsider",
      tokenIdentifier: outsiderToken,
      email: "out@example.com",
      name: "Out",
    }),
  );
  const asOutsider = t.withIdentity({
    tokenIdentifier: outsiderToken,
    subject: "user_outsider",
    email: "out@example.com",
  });
  await expect(
    asOutsider.mutation(api.reactions.toggle, { messageId, emoji: "👍" }),
  ).rejects.toThrow(/Not a channel member/);
});
```

- [ ] **Step 2: Run the tests — they should fail (module does not exist).**

Run: `cd slack-b2b-app && npm run test -- reactions.test`
Expected: FAIL with `Cannot resolve api.reactions.toggle`.

- [ ] **Step 3: Create `convex/reactions.ts` with `toggle` and `ALLOWED_EMOJI`.**

```typescript
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { assertChannelMember, ensureUser } from "./auth";
import type { Doc, Id } from "./_generated/dataModel";

export const ALLOWED_EMOJI = ["👍", "❤️", "😂", "🎉", "😢", "👀"] as const;
type AllowedEmoji = (typeof ALLOWED_EMOJI)[number];

function isAllowed(e: string): e is AllowedEmoji {
  return (ALLOWED_EMOJI as readonly string[]).includes(e);
}

export const toggle = mutation({
  args: { messageId: v.id("messages"), emoji: v.string() },
  handler: async (ctx, args) => {
    if (!isAllowed(args.emoji)) {
      throw new Error(`Emoji not allowed: ${args.emoji}`);
    }
    const message = await ctx.db.get(args.messageId);
    if (!message) throw new Error(`Message not found: ${args.messageId}`);
    if (message.deletedAt) throw new Error("Cannot react to a deleted message.");

    const user = await ensureUser(ctx);
    await assertChannelMember(ctx, user._id, message.channelId);

    const existing = await ctx.db
      .query("reactions")
      .withIndex("by_message_user_emoji", (q) =>
        q
          .eq("messageId", args.messageId)
          .eq("userId", user._id)
          .eq("emoji", args.emoji),
      )
      .unique();

    if (existing) {
      await ctx.db.delete(existing._id);
      return { toggled: "off" as const };
    }
    await ctx.db.insert("reactions", {
      messageId: args.messageId,
      userId: user._id,
      emoji: args.emoji,
      channelId: message.channelId,
    });
    return { toggled: "on" as const };
  },
});
```

- [ ] **Step 4: Run tests again.**

Run: `npm run test -- reactions.test`
Expected: 5/5 PASS.

- [ ] **Step 5: Commit.**

```bash
git add slack-b2b-app/convex/reactions.ts slack-b2b-app/convex/reactions.test.ts
git commit -m "reactions: toggle mutation with 6-emoji allowlist"
```

---

## Task 3: `convex/reactions.ts` — `listForMessages` query

**Files:**
- Modify: `slack-b2b-app/convex/reactions.ts`
- Modify: `slack-b2b-app/convex/reactions.test.ts`

- [ ] **Step 1: Append test cases to `convex/reactions.test.ts`.**

```typescript
test("reactions.listForMessages groups by emoji and joins names", async () => {
  const t = convexTest(schema, modules);
  const { messageId, aliceId, bobId } = await seedChannelWithTwoMembersAndMessage(t);
  const asBob = t.withIdentity({
    tokenIdentifier: TOKEN_BOB,
    subject: "user_bob",
    email: "bob@example.com",
  });
  await asAlice(t).mutation(api.reactions.toggle, { messageId, emoji: "👍" });
  await asBob.mutation(api.reactions.toggle, { messageId, emoji: "👍" });
  await asAlice(t).mutation(api.reactions.toggle, { messageId, emoji: "❤️" });

  const result = await asAlice(t).query(api.reactions.listForMessages, {
    messageIds: [messageId],
  });
  const forMsg = result[messageId];
  expect(forMsg).toHaveLength(2);
  const thumbs = forMsg.find((r: { emoji: string }) => r.emoji === "👍")!;
  expect(thumbs.count).toBe(2);
  expect(thumbs.userIds).toEqual(expect.arrayContaining([aliceId, bobId]));
  expect(thumbs.userNames).toEqual(expect.arrayContaining(["Alice", "Bob"]));
  const heart = forMsg.find((r: { emoji: string }) => r.emoji === "❤️")!;
  expect(heart.count).toBe(1);
});

test("reactions.listForMessages returns empty for messages with no reactions", async () => {
  const t = convexTest(schema, modules);
  const { messageId } = await seedChannelWithTwoMembersAndMessage(t);
  const result = await asAlice(t).query(api.reactions.listForMessages, {
    messageIds: [messageId],
  });
  expect(result[messageId] ?? []).toEqual([]);
});

test("reactions.listForMessages rejects batches over 300", async () => {
  const t = convexTest(schema, modules);
  await seedChannelWithTwoMembersAndMessage(t);
  const fakeIds = Array.from({ length: 301 }, () =>
    "k00000000000000000000000000000000" as Id<"messages">,
  );
  await expect(
    asAlice(t).query(api.reactions.listForMessages, { messageIds: fakeIds }),
  ).rejects.toThrow(/too many/i);
});
```

- [ ] **Step 2: Run tests — they should fail.**

Run: `npm run test -- reactions.test`
Expected: FAIL — `listForMessages is not a function`.

- [ ] **Step 3: Append `listForMessages` to `convex/reactions.ts`.**

```typescript
export const listForMessages = query({
  args: { messageIds: v.array(v.id("messages")) },
  handler: async (ctx, args) => {
    if (args.messageIds.length > 300) {
      throw new Error("Too many messageIds (max 300).");
    }
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");

    const rowsPerMessage = await Promise.all(
      args.messageIds.map((id) =>
        ctx.db
          .query("reactions")
          .withIndex("by_message", (q) => q.eq("messageId", id))
          .take(200),
      ),
    );
    const allRows: Doc<"reactions">[] = rowsPerMessage.flat();
    const uniqueUserIds = [...new Set(allRows.map((r) => r.userId))];
    const users = await Promise.all(uniqueUserIds.map((id) => ctx.db.get(id)));
    const nameById = new Map<Id<"users">, string>();
    for (const u of users) {
      if (u) nameById.set(u._id, u.name ?? "Unknown user");
    }

    const out: Record<
      Id<"messages">,
      Array<{ emoji: string; count: number; userIds: Id<"users">[]; userNames: string[] }>
    > = {};
    for (let i = 0; i < args.messageIds.length; i++) {
      const rows = rowsPerMessage[i];
      const groups = new Map<string, { userIds: Id<"users">[]; userNames: string[] }>();
      for (const r of rows) {
        const g = groups.get(r.emoji) ?? { userIds: [], userNames: [] };
        if (!g.userIds.includes(r.userId)) {
          g.userIds.push(r.userId);
          g.userNames.push(nameById.get(r.userId) ?? "Unknown user");
        }
        groups.set(r.emoji, g);
      }
      out[args.messageIds[i]] = [...groups.entries()].map(([emoji, g]) => ({
        emoji,
        count: g.userIds.length,
        userIds: g.userIds,
        userNames: g.userNames,
      }));
    }
    return out;
  },
});
```

- [ ] **Step 4: Run tests.**

Run: `npm run test -- reactions.test`
Expected: 8/8 PASS (5 from Task 2 + 3 new).

- [ ] **Step 5: Commit.**

```bash
git add slack-b2b-app/convex/reactions.ts slack-b2b-app/convex/reactions.test.ts
git commit -m "reactions: listForMessages with grouping and name join"
```

---

## Task 4: `convex/typing.ts` — `heartbeat`, `stop`, `listForChannel`

**Files:**
- Create: `slack-b2b-app/convex/typing.ts`
- Create: `slack-b2b-app/convex/typing.test.ts`

- [ ] **Step 1: Create `convex/typing.test.ts`.**

```typescript
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const ISSUER = "https://awaited-boxer-54.clerk.accounts.dev";
const TOKEN_ALICE = `${ISSUER}|user_alice`;
const TOKEN_BOB = `${ISSUER}|user_bob`;

async function seedTwoMemberChannel(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const aliceId = await ctx.db.insert("users", {
      clerkUserId: "user_alice",
      tokenIdentifier: TOKEN_ALICE,
      email: "a@e.com",
      name: "Alice",
    });
    const bobId = await ctx.db.insert("users", {
      clerkUserId: "user_bob",
      tokenIdentifier: TOKEN_BOB,
      email: "b@e.com",
      name: "Bob",
    });
    const orgId = await ctx.db.insert("organizations", {
      clerkOrgId: "org_1",
      slug: "acme",
      name: "Acme",
    });
    await ctx.db.insert("memberships", {
      userId: aliceId,
      organizationId: orgId,
      clerkMembershipId: "m_a",
      role: "org:admin",
    });
    await ctx.db.insert("memberships", {
      userId: bobId,
      organizationId: orgId,
      clerkMembershipId: "m_b",
      role: "org:member",
    });
    const channelId = await ctx.db.insert("channels", {
      organizationId: orgId,
      slug: "general",
      name: "General",
      createdBy: aliceId,
      isProtected: true,
    });
    for (const uid of [aliceId, bobId]) {
      await ctx.db.insert("channelMembers", { channelId, userId: uid, organizationId: orgId });
    }
    return { aliceId, bobId, orgId, channelId };
  });
}

const asAlice = (t: ReturnType<typeof convexTest>) =>
  t.withIdentity({ tokenIdentifier: TOKEN_ALICE, subject: "user_alice", email: "a@e.com" });
const asBob = (t: ReturnType<typeof convexTest>) =>
  t.withIdentity({ tokenIdentifier: TOKEN_BOB, subject: "user_bob", email: "b@e.com" });

test("typing.heartbeat inserts a row with expiresAt ~= now + 5000", async () => {
  const t = convexTest(schema, modules);
  const { channelId } = await seedTwoMemberChannel(t);
  const before = Date.now();
  await asAlice(t).mutation(api.typing.heartbeat, { channelId });
  const rows = await t.run(async (ctx) =>
    await ctx.db.query("typingIndicators").withIndex("by_channel", (q) => q.eq("channelId", channelId)).collect(),
  );
  expect(rows).toHaveLength(1);
  expect(rows[0].expiresAt).toBeGreaterThanOrEqual(before + 5000);
  expect(rows[0].expiresAt).toBeLessThanOrEqual(Date.now() + 5000);
});

test("typing.heartbeat twice patches the existing row (no duplicate)", async () => {
  const t = convexTest(schema, modules);
  const { channelId } = await seedTwoMemberChannel(t);
  await asAlice(t).mutation(api.typing.heartbeat, { channelId });
  await asAlice(t).mutation(api.typing.heartbeat, { channelId });
  const rows = await t.run(async (ctx) =>
    await ctx.db.query("typingIndicators").withIndex("by_channel", (q) => q.eq("channelId", channelId)).collect(),
  );
  expect(rows).toHaveLength(1);
});

test("typing.stop removes the caller's row", async () => {
  const t = convexTest(schema, modules);
  const { channelId } = await seedTwoMemberChannel(t);
  await asAlice(t).mutation(api.typing.heartbeat, { channelId });
  await asAlice(t).mutation(api.typing.stop, { channelId });
  const rows = await t.run(async (ctx) =>
    await ctx.db.query("typingIndicators").withIndex("by_channel", (q) => q.eq("channelId", channelId)).collect(),
  );
  expect(rows).toHaveLength(0);
});

test("typing.listForChannel excludes self and expired rows", async () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date("2026-04-23T12:00:00Z"));
    const t = convexTest(schema, modules);
    const { channelId } = await seedTwoMemberChannel(t);
    await asAlice(t).mutation(api.typing.heartbeat, { channelId });
    await asBob(t).mutation(api.typing.heartbeat, { channelId });

    // Alice's query sees only Bob.
    let list = await asAlice(t).query(api.typing.listForChannel, { channelId });
    expect(list.map((r: { name: string }) => r.name)).toEqual(["Bob"]);

    // Advance past 5s expiry — Bob's row is still in DB but filtered out.
    vi.setSystemTime(new Date("2026-04-23T12:00:06Z"));
    list = await asAlice(t).query(api.typing.listForChannel, { channelId });
    expect(list).toEqual([]);
  } finally {
    vi.useRealTimers();
  }
});

test("typing.listForChannel rejects non-member", async () => {
  const t = convexTest(schema, modules);
  const { channelId } = await seedTwoMemberChannel(t);
  const outToken = `${ISSUER}|user_out`;
  await t.run(async (ctx) =>
    await ctx.db.insert("users", {
      clerkUserId: "user_out",
      tokenIdentifier: outToken,
      email: "o@e.com",
      name: "Out",
    }),
  );
  const asOut = t.withIdentity({ tokenIdentifier: outToken, subject: "user_out", email: "o@e.com" });
  await expect(
    asOut.query(api.typing.listForChannel, { channelId }),
  ).rejects.toThrow(/Not a channel member/);
});
```

- [ ] **Step 2: Run — fails (module missing).**

Run: `npm run test -- typing.test`
Expected: FAIL.

- [ ] **Step 3: Create `convex/typing.ts`.**

```typescript
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { assertChannelMember, ensureUser } from "./auth";
import type { Id } from "./_generated/dataModel";

const TTL_MS = 5000;

export const heartbeat = mutation({
  args: { channelId: v.id("channels") },
  handler: async (ctx, args) => {
    const user = await ensureUser(ctx);
    const { channel } = await assertChannelMember(ctx, user._id, args.channelId);
    const existing = await ctx.db
      .query("typingIndicators")
      .withIndex("by_channel_and_user", (q) =>
        q.eq("channelId", args.channelId).eq("userId", user._id),
      )
      .unique();
    const expiresAt = Date.now() + TTL_MS;
    if (existing) {
      await ctx.db.patch(existing._id, { expiresAt });
    } else {
      await ctx.db.insert("typingIndicators", {
        channelId: args.channelId,
        userId: user._id,
        organizationId: channel.organizationId,
        expiresAt,
      });
    }
  },
});

export const stop = mutation({
  args: { channelId: v.id("channels") },
  handler: async (ctx, args) => {
    const user = await ensureUser(ctx);
    await assertChannelMember(ctx, user._id, args.channelId);
    const existing = await ctx.db
      .query("typingIndicators")
      .withIndex("by_channel_and_user", (q) =>
        q.eq("channelId", args.channelId).eq("userId", user._id),
      )
      .unique();
    if (existing) await ctx.db.delete(existing._id);
  },
});

export const listForChannel = query({
  args: { channelId: v.id("channels") },
  handler: async (ctx, args) => {
    const user = await ensureUser(ctx);
    await assertChannelMember(ctx, user._id, args.channelId);
    const now = Date.now();
    const rows = await ctx.db
      .query("typingIndicators")
      .withIndex("by_channel", (q) => q.eq("channelId", args.channelId))
      .take(50);
    const live = rows.filter((r) => r.expiresAt > now && r.userId !== user._id);
    const names = await Promise.all(live.map((r) => ctx.db.get(r.userId)));
    return live.map((r, i) => ({
      userId: r.userId as Id<"users">,
      name: names[i]?.name ?? "Unknown user",
      expiresAt: r.expiresAt,
    }));
  },
});
```

- [ ] **Step 4: Run tests.**

Run: `npm run test -- typing.test`
Expected: 5/5 PASS.

- [ ] **Step 5: Commit.**

```bash
git add slack-b2b-app/convex/typing.ts slack-b2b-app/convex/typing.test.ts
git commit -m "typing: heartbeat, stop, listForChannel with 5s expiry"
```

---

## Task 5: `convex/reads.ts` — `markRead` mutation

**Files:**
- Create: `slack-b2b-app/convex/reads.ts`
- Create: `slack-b2b-app/convex/reads.test.ts`

- [ ] **Step 1: Create `convex/reads.test.ts`.**

```typescript
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const ISSUER = "https://awaited-boxer-54.clerk.accounts.dev";
const TOKEN = `${ISSUER}|user_alice`;

async function seedChannel(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      clerkUserId: "user_alice",
      tokenIdentifier: TOKEN,
      email: "a@e.com",
      name: "Alice",
    });
    const orgId = await ctx.db.insert("organizations", {
      clerkOrgId: "org_1",
      slug: "acme",
      name: "Acme",
    });
    await ctx.db.insert("memberships", {
      userId,
      organizationId: orgId,
      clerkMembershipId: "m_a",
      role: "org:admin",
    });
    const channelId = await ctx.db.insert("channels", {
      organizationId: orgId,
      slug: "general",
      name: "General",
      createdBy: userId,
      isProtected: true,
    });
    await ctx.db.insert("channelMembers", { channelId, userId, organizationId: orgId });
    return { userId, orgId, channelId };
  });
}

const asAlice = (t: ReturnType<typeof convexTest>) =>
  t.withIdentity({ tokenIdentifier: TOKEN, subject: "user_alice", email: "a@e.com" });

test("reads.markRead inserts a channelReadStates row on first call", async () => {
  const t = convexTest(schema, modules);
  const { channelId } = await seedChannel(t);
  await asAlice(t).mutation(api.reads.markRead, { channelId });
  const rows = await t.run(async (ctx) =>
    await ctx.db.query("channelReadStates").collect(),
  );
  expect(rows).toHaveLength(1);
  expect(rows[0].channelId).toBe(channelId);
  expect(rows[0].lastReadAt).toBeGreaterThan(0);
});

test("reads.markRead patches the existing row on second call", async () => {
  const t = convexTest(schema, modules);
  const { channelId } = await seedChannel(t);
  await asAlice(t).mutation(api.reads.markRead, { channelId });
  const first = await t.run(async (ctx) =>
    await ctx.db.query("channelReadStates").first(),
  );
  await new Promise((r) => setTimeout(r, 10));
  await asAlice(t).mutation(api.reads.markRead, { channelId });
  const rows = await t.run(async (ctx) =>
    await ctx.db.query("channelReadStates").collect(),
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]._id).toBe(first!._id);
  expect(rows[0].lastReadAt).toBeGreaterThan(first!.lastReadAt);
});

test("reads.markRead rejects non-channel-member", async () => {
  const t = convexTest(schema, modules);
  const { channelId } = await seedChannel(t);
  const outToken = `${ISSUER}|user_out`;
  await t.run(async (ctx) =>
    await ctx.db.insert("users", {
      clerkUserId: "user_out",
      tokenIdentifier: outToken,
      email: "o@e.com",
      name: "Out",
    }),
  );
  const asOut = t.withIdentity({ tokenIdentifier: outToken, subject: "user_out", email: "o@e.com" });
  await expect(
    asOut.mutation(api.reads.markRead, { channelId }),
  ).rejects.toThrow(/Not a channel member/);
});
```

- [ ] **Step 2: Run — fails.**

Run: `npm run test -- reads.test`
Expected: FAIL.

- [ ] **Step 3: Create `convex/reads.ts`.**

```typescript
import { v } from "convex/values";
import { mutation } from "./_generated/server";
import { assertChannelMember, ensureUser } from "./auth";

export const markRead = mutation({
  args: { channelId: v.id("channels") },
  handler: async (ctx, args) => {
    const user = await ensureUser(ctx);
    const { channel } = await assertChannelMember(ctx, user._id, args.channelId);
    const existing = await ctx.db
      .query("channelReadStates")
      .withIndex("by_user_and_channel", (q) =>
        q.eq("userId", user._id).eq("channelId", args.channelId),
      )
      .unique();
    const lastReadAt = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, { lastReadAt });
    } else {
      await ctx.db.insert("channelReadStates", {
        userId: user._id,
        channelId: args.channelId,
        organizationId: channel.organizationId,
        lastReadAt,
      });
    }
  },
});
```

- [ ] **Step 4: Run tests.**

Run: `npm run test -- reads.test`
Expected: 3/3 PASS.

- [ ] **Step 5: Commit.**

```bash
git add slack-b2b-app/convex/reads.ts slack-b2b-app/convex/reads.test.ts
git commit -m "reads: markRead mutation (upsert channelReadStates)"
```

---

## Task 6: Extend `channels.listMine` with `unreadCount`

**Files:**
- Modify: `slack-b2b-app/convex/channels.ts`
- Modify: `slack-b2b-app/convex/channels.test.ts`

- [ ] **Step 1: Add new tests to `convex/channels.test.ts` near the existing `listMine` block. Open the file and append after the last `listMine` test.**

```typescript
test("channels.listMine returns unreadCount=0 right after markRead", async () => {
  const t = convexTest(schema, modules);
  const { channelId } = await seedAcmeWithGeneral(t);
  const asJane = t.withIdentity({
    tokenIdentifier: TOKEN,
    subject: "user_abc",
    email: "jane@example.com",
  });
  // Someone else posts first.
  await t.run(async (ctx) => {
    const otherId = await ctx.db.insert("users", {
      clerkUserId: "other",
      tokenIdentifier: `${ISSUER}|other`,
      email: "other@e.com",
      name: "Other",
    });
    await ctx.db.insert("channelMembers", { channelId, userId: otherId, organizationId: (await ctx.db.get(channelId))!.organizationId });
    await ctx.db.insert("messages", { channelId, userId: otherId, text: "hi" });
  });
  await asJane.mutation(api.reads.markRead, { channelId });
  const list = await asJane.query(api.channels.listMine, { workspaceSlug: "acme" });
  const general = list.find((c: { slug: string }) => c.slug === "general")!;
  expect(general.unreadCount).toBe(0);
  expect(general.overflow).toBe(false);
});

test("channels.listMine counts messages after lastReadAt", async () => {
  const t = convexTest(schema, modules);
  const { channelId } = await seedAcmeWithGeneral(t);
  const asJane = t.withIdentity({
    tokenIdentifier: TOKEN,
    subject: "user_abc",
    email: "jane@example.com",
  });
  await asJane.mutation(api.reads.markRead, { channelId });
  await new Promise((r) => setTimeout(r, 5));
  await t.run(async (ctx) => {
    const otherId = await ctx.db.insert("users", {
      clerkUserId: "other",
      tokenIdentifier: `${ISSUER}|other`,
      email: "other@e.com",
      name: "Other",
    });
    const orgId = (await ctx.db.get(channelId))!.organizationId;
    await ctx.db.insert("channelMembers", { channelId, userId: otherId, organizationId: orgId });
    for (let i = 0; i < 3; i++) {
      await ctx.db.insert("messages", { channelId, userId: otherId, text: `m${i}` });
    }
  });
  const list = await asJane.query(api.channels.listMine, { workspaceSlug: "acme" });
  const general = list.find((c: { slug: string }) => c.slug === "general")!;
  expect(general.unreadCount).toBe(3);
  expect(general.overflow).toBe(false);
});

test("channels.listMine excludes own messages and tombstones from unreadCount", async () => {
  const t = convexTest(schema, modules);
  const { userId, channelId } = await seedAcmeWithGeneral(t);
  const asJane = t.withIdentity({
    tokenIdentifier: TOKEN,
    subject: "user_abc",
    email: "jane@example.com",
  });
  await asJane.mutation(api.reads.markRead, { channelId });
  await new Promise((r) => setTimeout(r, 5));
  await t.run(async (ctx) => {
    const otherId = await ctx.db.insert("users", {
      clerkUserId: "other",
      tokenIdentifier: `${ISSUER}|other`,
      email: "other@e.com",
      name: "Other",
    });
    const orgId = (await ctx.db.get(channelId))!.organizationId;
    await ctx.db.insert("channelMembers", { channelId, userId: otherId, organizationId: orgId });
    // 2 from self (ignored), 1 from other (counted), 1 tombstoned from other (ignored).
    await ctx.db.insert("messages", { channelId, userId, text: "self-a" });
    await ctx.db.insert("messages", { channelId, userId, text: "self-b" });
    await ctx.db.insert("messages", { channelId, userId: otherId, text: "other-alive" });
    await ctx.db.insert("messages", {
      channelId,
      userId: otherId,
      text: "other-deleted",
      deletedAt: Date.now(),
    });
  });
  const list = await asJane.query(api.channels.listMine, { workspaceSlug: "acme" });
  const general = list.find((c: { slug: string }) => c.slug === "general")!;
  expect(general.unreadCount).toBe(1);
});

test("channels.listMine caps unread at 50 with overflow=true", async () => {
  const t = convexTest(schema, modules);
  const { channelId } = await seedAcmeWithGeneral(t);
  const asJane = t.withIdentity({
    tokenIdentifier: TOKEN,
    subject: "user_abc",
    email: "jane@example.com",
  });
  await asJane.mutation(api.reads.markRead, { channelId });
  await new Promise((r) => setTimeout(r, 5));
  await t.run(async (ctx) => {
    const otherId = await ctx.db.insert("users", {
      clerkUserId: "other",
      tokenIdentifier: `${ISSUER}|other`,
      email: "other@e.com",
      name: "Other",
    });
    const orgId = (await ctx.db.get(channelId))!.organizationId;
    await ctx.db.insert("channelMembers", { channelId, userId: otherId, organizationId: orgId });
    for (let i = 0; i < 55; i++) {
      await ctx.db.insert("messages", { channelId, userId: otherId, text: `m${i}` });
    }
  });
  const list = await asJane.query(api.channels.listMine, { workspaceSlug: "acme" });
  const general = list.find((c: { slug: string }) => c.slug === "general")!;
  expect(general.unreadCount).toBe(50);
  expect(general.overflow).toBe(true);
});

test("channels.listMine with no readState row counts every non-own, non-deleted message", async () => {
  const t = convexTest(schema, modules);
  const { channelId } = await seedAcmeWithGeneral(t);
  const asJane = t.withIdentity({
    tokenIdentifier: TOKEN,
    subject: "user_abc",
    email: "jane@example.com",
  });
  await t.run(async (ctx) => {
    const otherId = await ctx.db.insert("users", {
      clerkUserId: "other",
      tokenIdentifier: `${ISSUER}|other`,
      email: "other@e.com",
      name: "Other",
    });
    const orgId = (await ctx.db.get(channelId))!.organizationId;
    await ctx.db.insert("channelMembers", { channelId, userId: otherId, organizationId: orgId });
    await ctx.db.insert("messages", { channelId, userId: otherId, text: "hi" });
    await ctx.db.insert("messages", { channelId, userId: otherId, text: "hello" });
  });
  const list = await asJane.query(api.channels.listMine, { workspaceSlug: "acme" });
  const general = list.find((c: { slug: string }) => c.slug === "general")!;
  expect(general.unreadCount).toBe(2);
});
```

- [ ] **Step 2: Run — expect failures (listMine doesn't return `unreadCount`).**

Run: `npm run test -- channels.test`
Expected: FAIL on the new tests.

- [ ] **Step 3: Edit `convex/channels.ts`. Find the `listMine` export. After the existing channel-fetch loop that produces the final `channels` array, wrap each channel with the unread computation.**

Replace the current `return` in `listMine` with:

```typescript
const me = user;  // caller's Convex user row (already resolved above)
const enriched = await Promise.all(
  channels.map(async (ch) => {
    const readState = await ctx.db
      .query("channelReadStates")
      .withIndex("by_user_and_channel", (q) =>
        q.eq("userId", me._id).eq("channelId", ch._id),
      )
      .unique();
    const lastReadAt = readState?.lastReadAt ?? 0;
    const probe = await ctx.db
      .query("messages")
      .withIndex("by_channel", (q) => q.eq("channelId", ch._id))
      .order("desc")
      .take(51);
    let unreadCount = 0;
    for (const m of probe) {
      if (m._creationTime <= lastReadAt) break;
      if (m.deletedAt) continue;
      if (m.userId === me._id) continue;
      unreadCount++;
    }
    const overflow = unreadCount > 50;
    return { ...ch, unreadCount: Math.min(unreadCount, 50), overflow };
  }),
);
return enriched;
```

If `listMine`'s local variable for the current user isn't called `user`, adapt the `me` binding accordingly. If the function does not currently `await` the caller's user row, add one line at the top after `ensureUser` / `assertMember`:

```typescript
const user = await ensureUser(ctx);  // should already exist; otherwise add
```

- [ ] **Step 4: Run all tests.**

Run: `npm run test`
Expected: all existing tests still pass + 5 new `listMine` tests pass.

- [ ] **Step 5: Commit.**

```bash
git add slack-b2b-app/convex/channels.ts slack-b2b-app/convex/channels.test.ts
git commit -m "channels: listMine returns unreadCount + overflow per channel"
```

---

## Task 7: Cascade on `channels.deleteChannel`

**Files:**
- Modify: `slack-b2b-app/convex/channels.ts`
- Modify: `slack-b2b-app/convex/channels.test.ts`

- [ ] **Step 1: Add a cascade test to `convex/channels.test.ts` (append at the end of the file).**

```typescript
test("channels.deleteChannel cascades reactions, typingIndicators, channelReadStates", async () => {
  const t = convexTest(schema, modules);
  const { userId, channelId, orgId } = await seedAcmeWithGeneral(t);
  // Seed a non-protected channel we can delete.
  const delChannelId = await t.run(async (ctx) => {
    const id = await ctx.db.insert("channels", {
      organizationId: orgId,
      slug: "doomed",
      name: "Doomed",
      createdBy: userId,
      isProtected: false,
    });
    await ctx.db.insert("channelMembers", { channelId: id, userId, organizationId: orgId });
    const msg = await ctx.db.insert("messages", { channelId: id, userId, text: "x" });
    await ctx.db.insert("reactions", {
      messageId: msg,
      userId,
      emoji: "👍",
      channelId: id,
    });
    await ctx.db.insert("typingIndicators", {
      channelId: id,
      userId,
      organizationId: orgId,
      expiresAt: Date.now() + 5000,
    });
    await ctx.db.insert("channelReadStates", {
      channelId: id,
      userId,
      organizationId: orgId,
      lastReadAt: Date.now(),
    });
    return id;
  });
  // Silence unused warning from the seeded channelId.
  expect(channelId).toBeTruthy();

  const asJane = t.withIdentity({
    tokenIdentifier: TOKEN,
    subject: "user_abc",
    email: "jane@example.com",
  });
  await asJane.mutation(api.channels.deleteChannel, { channelId: delChannelId });

  // Let scheduled self-reschedule settle.
  await t.finishInProgressScheduledFunctions();

  const counts = await t.run(async (ctx) => ({
    reactions: (await ctx.db.query("reactions").withIndex("by_channel", (q) => q.eq("channelId", delChannelId)).collect()).length,
    typing: (await ctx.db.query("typingIndicators").withIndex("by_channel", (q) => q.eq("channelId", delChannelId)).collect()).length,
    reads: (await ctx.db.query("channelReadStates").withIndex("by_channel", (q) => q.eq("channelId", delChannelId)).collect()).length,
    channels: (await ctx.db.query("channels").collect()).filter((c) => c._id === delChannelId).length,
  }));
  expect(counts).toEqual({ reactions: 0, typing: 0, reads: 0, channels: 0 });
});
```

- [ ] **Step 2: Run — expect failure (cascade not wired).**

Run: `npm run test -- channels.test`
Expected: FAIL — residual rows remain.

- [ ] **Step 3: Extend `deleteChannel` in `convex/channels.ts`.** Find the existing mutation. Before the existing `messages` + `channelMembers` batch-delete block, insert three new batch-delete blocks. Each follows the existing `.take(256)` + self-reschedule pattern. Example for one table:

```typescript
const reactionsBatch = await ctx.db
  .query("reactions")
  .withIndex("by_channel", (q) => q.eq("channelId", args.channelId))
  .take(256);
for (const r of reactionsBatch) await ctx.db.delete(r._id);
if (reactionsBatch.length === 256) {
  await ctx.scheduler.runAfter(0, api.channels.deleteChannel, {
    channelId: args.channelId,
  });
  return;
}

const typingBatch = await ctx.db
  .query("typingIndicators")
  .withIndex("by_channel", (q) => q.eq("channelId", args.channelId))
  .take(256);
for (const r of typingBatch) await ctx.db.delete(r._id);
if (typingBatch.length === 256) {
  await ctx.scheduler.runAfter(0, api.channels.deleteChannel, {
    channelId: args.channelId,
  });
  return;
}

const readsBatch = await ctx.db
  .query("channelReadStates")
  .withIndex("by_channel", (q) => q.eq("channelId", args.channelId))
  .take(256);
for (const r of readsBatch) await ctx.db.delete(r._id);
if (readsBatch.length === 256) {
  await ctx.scheduler.runAfter(0, api.channels.deleteChannel, {
    channelId: args.channelId,
  });
  return;
}
```

Insert these three blocks in that order (reactions → typing → reads) immediately before the existing messages cascade. Keep the existing authorization / protected-channel checks at the top of the handler untouched.

- [ ] **Step 4: Run tests.**

Run: `npm run test`
Expected: all green, including the new cascade test.

- [ ] **Step 5: Commit.**

```bash
git add slack-b2b-app/convex/channels.ts slack-b2b-app/convex/channels.test.ts
git commit -m "channels: cascade reactions, typing, reads on deleteChannel"
```

---

## Task 8: Cascade on `clerkSync.deleteMembership`

**Files:**
- Modify: `slack-b2b-app/convex/clerkSync.ts`
- Modify: `slack-b2b-app/convex/clerkSync.test.ts`

- [ ] **Step 1: Add a cascade test to `convex/clerkSync.test.ts`.** Append at the end of the file (mirror the existing `deleteMembership` test's seed pattern).

```typescript
test("deleteMembership cascades reactions, typingIndicators, channelReadStates within the workspace only", async () => {
  const t = convexTest(schema, modules);
  const { userId, orgId, clerkMembershipId } = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      clerkUserId: "user_leave",
      tokenIdentifier: `${ISSUER}|user_leave`,
      email: "l@e.com",
      name: "L",
    });
    const orgA = await ctx.db.insert("organizations", {
      clerkOrgId: "org_A",
      slug: "acme",
      name: "A",
    });
    const orgB = await ctx.db.insert("organizations", {
      clerkOrgId: "org_B",
      slug: "bee",
      name: "B",
    });
    const memA = await ctx.db.insert("memberships", {
      userId,
      organizationId: orgA,
      clerkMembershipId: "mem_a",
      role: "org:member",
    });
    await ctx.db.insert("memberships", {
      userId,
      organizationId: orgB,
      clerkMembershipId: "mem_b",
      role: "org:member",
    });
    const chA = await ctx.db.insert("channels", {
      organizationId: orgA,
      slug: "general",
      name: "General",
      createdBy: userId,
      isProtected: true,
    });
    const chB = await ctx.db.insert("channels", {
      organizationId: orgB,
      slug: "general",
      name: "General",
      createdBy: userId,
      isProtected: true,
    });
    await ctx.db.insert("channelMembers", { channelId: chA, userId, organizationId: orgA });
    await ctx.db.insert("channelMembers", { channelId: chB, userId, organizationId: orgB });
    const msgA = await ctx.db.insert("messages", { channelId: chA, userId, text: "hi" });
    const msgB = await ctx.db.insert("messages", { channelId: chB, userId, text: "hi" });
    await ctx.db.insert("reactions", {
      messageId: msgA,
      userId,
      emoji: "👍",
      channelId: chA,
    });
    await ctx.db.insert("reactions", {
      messageId: msgB,
      userId,
      emoji: "👍",
      channelId: chB,
    });
    await ctx.db.insert("typingIndicators", {
      channelId: chA,
      userId,
      organizationId: orgA,
      expiresAt: Date.now() + 5000,
    });
    await ctx.db.insert("typingIndicators", {
      channelId: chB,
      userId,
      organizationId: orgB,
      expiresAt: Date.now() + 5000,
    });
    await ctx.db.insert("channelReadStates", {
      channelId: chA,
      userId,
      organizationId: orgA,
      lastReadAt: Date.now(),
    });
    await ctx.db.insert("channelReadStates", {
      channelId: chB,
      userId,
      organizationId: orgB,
      lastReadAt: Date.now(),
    });
    return { userId, orgId: orgA, clerkMembershipId: "mem_a", memA };
  });

  await t.mutation(internal.clerkSync.deleteMembership, {
    clerkMembershipId,
  });
  await t.finishInProgressScheduledFunctions();

  const result = await t.run(async (ctx) => {
    const reactionsA = await ctx.db.query("reactions").withIndex("by_user_and_channel", (q) => q.eq("userId", userId)).collect();
    const typingA = await ctx.db.query("typingIndicators").withIndex("by_user_and_organization", (q) => q.eq("userId", userId).eq("organizationId", orgId)).collect();
    const readsA = await ctx.db.query("channelReadStates").withIndex("by_user_and_organization", (q) => q.eq("userId", userId).eq("organizationId", orgId)).collect();
    const allReactions = await ctx.db.query("reactions").collect();
    const allTyping = await ctx.db.query("typingIndicators").collect();
    const allReads = await ctx.db.query("channelReadStates").collect();
    return {
      reactionsInA: reactionsA.filter((r) => r.channelId !== undefined && typingA.every((t) => t.channelId !== r.channelId)).length,
      typingInA: typingA.length,
      readsInA: readsA.length,
      totalReactions: allReactions.length,
      totalTyping: allTyping.length,
      totalReads: allReads.length,
    };
  });
  expect(result.typingInA).toBe(0);
  expect(result.readsInA).toBe(0);
  // orgB still has one of each.
  expect(result.totalTyping).toBe(1);
  expect(result.totalReads).toBe(1);
  expect(result.totalReactions).toBe(1);
});
```

Note: the test uses `internal.clerkSync.deleteMembership` — if the existing handler is registered as `api.clerkSync.deleteMembership`, use the same import path as the existing tests in this file.

- [ ] **Step 2: Run — expect failure.**

Run: `npm run test -- clerkSync.test`
Expected: FAIL — residual rows.

- [ ] **Step 3: Open `convex/clerkSync.ts`, find `deleteMembership`, and add three cascade steps before the existing `channelMembers` cascade.** Place after the existing lookup that resolves `userId` + `organizationId` from the membership row.

```typescript
// Cascade typing indicators for this user in this workspace.
for (;;) {
  const batch = await ctx.db
    .query("typingIndicators")
    .withIndex("by_user_and_organization", (q) =>
      q.eq("userId", user._id).eq("organizationId", membership.organizationId),
    )
    .take(256);
  for (const r of batch) await ctx.db.delete(r._id);
  if (batch.length < 256) break;
}

// Cascade read states for this user in this workspace.
for (;;) {
  const batch = await ctx.db
    .query("channelReadStates")
    .withIndex("by_user_and_organization", (q) =>
      q.eq("userId", user._id).eq("organizationId", membership.organizationId),
    )
    .take(256);
  for (const r of batch) await ctx.db.delete(r._id);
  if (batch.length < 256) break;
}

// Cascade reactions: iterate the user's channelMembers rows in this workspace
// to get channelIds, then delete reactions by (user, channel).
const userChannelMemberships = await ctx.db
  .query("channelMembers")
  .withIndex("by_user_and_organization", (q) =>
    q.eq("userId", user._id).eq("organizationId", membership.organizationId),
  )
  .collect();
for (const cm of userChannelMemberships) {
  for (;;) {
    const batch = await ctx.db
      .query("reactions")
      .withIndex("by_user_and_channel", (q) =>
        q.eq("userId", user._id).eq("channelId", cm.channelId),
      )
      .take(256);
    for (const r of batch) await ctx.db.delete(r._id);
    if (batch.length < 256) break;
  }
}
```

Reuse the same local variable names (`user`, `membership`) already used by the existing handler.

- [ ] **Step 4: Run all tests.**

Run: `npm run test`
Expected: all green.

- [ ] **Step 5: Commit.**

```bash
git add slack-b2b-app/convex/clerkSync.ts slack-b2b-app/convex/clerkSync.test.ts
git commit -m "clerkSync: cascade reactions, typing, reads on deleteMembership"
```

---

## Task 9: `<ReactionBar>` component + wire into `MessageRow`

**Files:**
- Create: `slack-b2b-app/components/messaging/ReactionBar.tsx`
- Modify: `slack-b2b-app/components/messaging/MessageRow.tsx`

- [ ] **Step 1: Create `components/messaging/ReactionBar.tsx`.**

```typescript
"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

const ALLOWED_EMOJI = ["👍", "❤️", "😂", "🎉", "😢", "👀"] as const;

type ReactionGroup = {
  emoji: string;
  count: number;
  userIds: Id<"users">[];
  userNames: string[];
};

function nameSummary(names: string[], emoji: string): string {
  if (names.length <= 5) return `${names.join(", ")} reacted with ${emoji}`;
  const head = names.slice(0, 5).join(", ");
  return `${head} and ${names.length - 5} more reacted with ${emoji}`;
}

export function ReactionBar({
  messageId,
  reactions,
  currentUserId,
}: {
  messageId: Id<"messages">;
  reactions: ReactionGroup[];
  currentUserId: Id<"users"> | null;
}) {
  const toggle = useMutation(api.reactions.toggle);
  const [pickerOpen, setPickerOpen] = useState(false);

  return (
    <div className="flex items-center gap-1 mt-1 flex-wrap">
      {reactions.map((r) => {
        const mine = !!currentUserId && r.userIds.includes(currentUserId);
        return (
          <button
            key={r.emoji}
            type="button"
            title={nameSummary(r.userNames, r.emoji)}
            onClick={() => void toggle({ messageId, emoji: r.emoji })}
            className={`text-xs px-1.5 py-0.5 rounded border ${
              mine
                ? "bg-blue-100 border-blue-300 dark:bg-blue-900/40 dark:border-blue-700"
                : "bg-zinc-100 border-zinc-200 dark:bg-zinc-800 dark:border-zinc-700"
            }`}
          >
            {r.emoji} {r.count}
          </button>
        );
      })}

      <div className="relative">
        <button
          type="button"
          className="text-xs px-1.5 py-0.5 rounded border border-zinc-200 dark:border-zinc-700 opacity-0 group-hover:opacity-100"
          onClick={() => setPickerOpen((v) => !v)}
          aria-label="Add reaction"
        >
          + 😀
        </button>
        {pickerOpen && (
          <div className="absolute bottom-full left-0 mb-1 flex gap-1 p-1 bg-white dark:bg-zinc-800 border rounded shadow z-10">
            {ALLOWED_EMOJI.map((e) => (
              <button
                key={e}
                type="button"
                className="text-lg hover:bg-zinc-100 dark:hover:bg-zinc-700 rounded px-1"
                onClick={() => {
                  void toggle({ messageId, emoji: e });
                  setPickerOpen(false);
                }}
              >
                {e}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Modify `components/messaging/MessageRow.tsx` to accept and render reactions.** Add `reactions?: ReactionGroup[]` to props, and render `<ReactionBar>` below the text when `!tombstoned`.

Replace the file's current export with:

```typescript
"use client";

import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { ReactionBar } from "@/components/messaging/ReactionBar";

type ReactionGroup = {
  emoji: string;
  count: number;
  userIds: Id<"users">[];
  userNames: string[];
};

function formatTime(creationTime: number): string {
  const d = new Date(creationTime);
  const hh = d.getHours().toString().padStart(2, "0");
  const mm = d.getMinutes().toString().padStart(2, "0");
  return `${hh}:${mm}`;
}

export function MessageRow({
  message,
  author,
  isOwn,
  reactions,
  currentUserId,
}: {
  message: Doc<"messages">;
  author: { _id: Id<"users">; name: string | null; imageUrl: string | null };
  isOwn: boolean;
  reactions?: ReactionGroup[];
  currentUserId: Id<"users"> | null;
}) {
  const deleteMessage = useMutation(api.messages.deleteMessage);
  const tombstoned = !!message.deletedAt;

  return (
    <div className="group flex gap-3 px-4 py-1 hover:bg-zinc-50 dark:hover:bg-zinc-900/30">
      <div className="w-9 h-9 rounded bg-zinc-300 dark:bg-zinc-700 flex-shrink-0 overflow-hidden">
        {author.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={author.imageUrl} alt="" className="w-full h-full object-cover" />
        ) : null}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2">
          <span className="font-semibold text-sm">{author.name ?? "Deleted user"}</span>
          <span className="text-xs text-zinc-500">{formatTime(message._creationTime)}</span>
        </div>
        <div className="text-sm whitespace-pre-wrap break-words">
          {tombstoned ? (
            <span className="italic text-zinc-400">This message was deleted</span>
          ) : (
            message.text
          )}
        </div>
        {!tombstoned && (
          <ReactionBar
            messageId={message._id}
            reactions={reactions ?? []}
            currentUserId={currentUserId}
          />
        )}
      </div>
      {isOwn && !tombstoned && (
        <button
          className="opacity-0 group-hover:opacity-100 text-xs text-red-500 hover:underline self-start"
          onClick={() => {
            if (confirm("Delete this message?")) {
              void deleteMessage({ messageId: message._id });
            }
          }}
        >
          Delete
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Confirm types compile.**

Run: `npm run build`
Expected: clean build (TypeScript errors surface here).

- [ ] **Step 4: Commit.**

```bash
git add slack-b2b-app/components/messaging/ReactionBar.tsx slack-b2b-app/components/messaging/MessageRow.tsx
git commit -m "ui: ReactionBar component; MessageRow renders reactions"
```

---

## Task 10: Wire reactions subscription into `MessageList`

**Files:**
- Modify: `slack-b2b-app/components/messaging/MessageList.tsx`

- [ ] **Step 1: Edit `MessageList.tsx`. Replace the import block and the component body to subscribe to `api.reactions.listForMessages`, and pass per-row slices into `MessageRow`.**

Keep the existing pagination + scroll logic intact. The new code threads a `reactions` prop into each row.

Find the block that maps `displayed.map((row) => <MessageRow .../>)` and replace it with:

```typescript
{displayed.map((row) => (
  <MessageRow
    key={row.message._id}
    message={row.message}
    author={row.author}
    isOwn={!!me && row.author._id === me._id}
    reactions={reactionsByMessage[row.message._id]}
    currentUserId={me?._id ?? null}
  />
))}
```

Above the `useLayoutEffect`, after the existing `usePaginatedQuery` call, add:

```typescript
const messageIds = displayed.map((r) => r.message._id).slice(-300);
const reactionsByMessage =
  useQuery(api.reactions.listForMessages, { messageIds }) ?? {};
```

If `useQuery` is not already imported, add it to the existing `import { usePaginatedQuery, useQuery } from "convex/react"` line.

- [ ] **Step 2: Build to catch type issues.**

Run: `npm run build`
Expected: clean.

- [ ] **Step 3: Commit.**

```bash
git add slack-b2b-app/components/messaging/MessageList.tsx
git commit -m "ui: MessageList subscribes to reactions and passes per-row slices"
```

---

## Task 11: `useTypingHeartbeat` hook + `MessageComposer` wiring

**Files:**
- Create: `slack-b2b-app/hooks/useTypingHeartbeat.ts`
- Modify: `slack-b2b-app/components/messaging/MessageComposer.tsx`

- [ ] **Step 1: Create `hooks/useTypingHeartbeat.ts`.**

```typescript
"use client";

import { useEffect, useRef } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

const HEARTBEAT_MS = 3000;
const BLUR_GRACE_MS = 1000;

export function useTypingHeartbeat(channelId: Id<"channels">) {
  const heartbeat = useMutation(api.typing.heartbeat);
  const stop = useMutation(api.typing.stop);
  const lastSentRef = useRef(0);
  const blurTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (blurTimerRef.current) clearTimeout(blurTimerRef.current);
      void stop({ channelId });
    };
  }, [channelId, stop]);

  return {
    onKey: () => {
      const now = Date.now();
      if (now - lastSentRef.current < HEARTBEAT_MS) return;
      lastSentRef.current = now;
      void heartbeat({ channelId });
    },
    onSend: () => {
      lastSentRef.current = 0;
      void stop({ channelId });
    },
    onBlur: () => {
      if (blurTimerRef.current) clearTimeout(blurTimerRef.current);
      blurTimerRef.current = setTimeout(() => {
        void stop({ channelId });
      }, BLUR_GRACE_MS);
    },
    onFocus: () => {
      if (blurTimerRef.current) {
        clearTimeout(blurTimerRef.current);
        blurTimerRef.current = null;
      }
    },
  };
}
```

- [ ] **Step 2: Modify `components/messaging/MessageComposer.tsx`.** Import and wire the hook. Add handlers to the textarea.

```typescript
import { useTypingHeartbeat } from "@/hooks/useTypingHeartbeat";
// ... existing imports ...

// inside the component, after the existing useState declarations:
const typing = useTypingHeartbeat(channelId);
```

On the textarea JSX, add handlers:

```typescript
<textarea
  /* ...existing props... */
  onChange={(e) => {
    setText(e.target.value);
    typing.onKey();
  }}
  onBlur={typing.onBlur}
  onFocus={typing.onFocus}
/>
```

In the send handler, after the successful send call, add:

```typescript
typing.onSend();
```

- [ ] **Step 3: Build.**

Run: `npm run build`
Expected: clean.

- [ ] **Step 4: Commit.**

```bash
git add slack-b2b-app/hooks/useTypingHeartbeat.ts slack-b2b-app/components/messaging/MessageComposer.tsx
git commit -m "ui: useTypingHeartbeat hook wired into MessageComposer"
```

---

## Task 12: `<TypingBar>` + channel page mount

**Files:**
- Create: `slack-b2b-app/components/messaging/TypingBar.tsx`
- Modify: `slack-b2b-app/app/[slug]/channels/[channel]/page.tsx`

- [ ] **Step 1: Create `components/messaging/TypingBar.tsx`.**

```typescript
"use client";

import { useEffect, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

function summarize(names: string[]): string {
  if (names.length === 0) return "";
  if (names.length === 1) return `${names[0]} is typing…`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`;
  if (names.length === 3)
    return `${names[0]}, ${names[1]}, and 1 other are typing…`;
  return "Several people are typing…";
}

export function TypingBar({ channelId }: { channelId: Id<"channels"> }) {
  const typers = useQuery(api.typing.listForChannel, { channelId }) ?? [];
  const [, setTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const now = Date.now();
  const live = typers.filter((t) => t.expiresAt > now);
  const text = summarize(live.map((t) => t.name));

  return (
    <div className="h-5 px-4 text-xs text-zinc-500 italic">
      {text || " "}
    </div>
  );
}
```

- [ ] **Step 2: Open `app/[slug]/channels/[channel]/page.tsx`.** Add the import and render the bar between the message list and the composer.

```typescript
import { TypingBar } from "@/components/messaging/TypingBar";
```

In the JSX, place `<TypingBar channelId={channel._id} />` immediately above `<MessageComposer channelId={channel._id} />` in the existing layout.

- [ ] **Step 3: Build.**

Run: `npm run build`
Expected: clean.

- [ ] **Step 4: Commit.**

```bash
git add slack-b2b-app/components/messaging/TypingBar.tsx slack-b2b-app/app/[slug]/channels/[channel]/page.tsx
git commit -m "ui: TypingBar rendered above MessageComposer"
```

---

## Task 13: `useMarkChannelRead` hook + `MessageList` wiring

**Files:**
- Create: `slack-b2b-app/hooks/useMarkChannelRead.ts`
- Modify: `slack-b2b-app/components/messaging/MessageList.tsx`

- [ ] **Step 1: Create `hooks/useMarkChannelRead.ts`.**

```typescript
"use client";

import { useEffect, useRef } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

const THROTTLE_MS = 2000;

export function useMarkChannelRead(
  channelId: Id<"channels">,
  atBottom: boolean,
  newestCreationTime: number | undefined,
) {
  const markRead = useMutation(api.reads.markRead);
  const lastSentRef = useRef(0);

  useEffect(() => {
    lastSentRef.current = Date.now();
    void markRead({ channelId });
  }, [channelId, markRead]);

  useEffect(() => {
    if (!atBottom || !newestCreationTime) return;
    const now = Date.now();
    if (now - lastSentRef.current < THROTTLE_MS) return;
    lastSentRef.current = now;
    void markRead({ channelId });
  }, [atBottom, newestCreationTime, channelId, markRead]);
}
```

- [ ] **Step 2: Modify `MessageList.tsx` to call the hook.** Add the import:

```typescript
import { useMarkChannelRead } from "@/hooks/useMarkChannelRead";
```

Inside the component, after the `displayed` and `atBottom` are established, add:

```typescript
const newestCreationTime = displayed.length > 0
  ? displayed[displayed.length - 1].message._creationTime
  : undefined;
useMarkChannelRead(channelId, atBottom, newestCreationTime);
```

- [ ] **Step 3: Build.**

Run: `npm run build`
Expected: clean.

- [ ] **Step 4: Commit.**

```bash
git add slack-b2b-app/hooks/useMarkChannelRead.ts slack-b2b-app/components/messaging/MessageList.tsx
git commit -m "ui: useMarkChannelRead wired into MessageList (mount + at-bottom)"
```

---

## Task 14: `WorkspaceSidebar` unread badge + bold

**Files:**
- Modify: `slack-b2b-app/components/messaging/WorkspaceSidebar.tsx`

- [ ] **Step 1: Edit `WorkspaceSidebar.tsx`.** Find the `channels.map((ch) => ...)` block and replace with:

```typescript
{channels.map((ch) => {
  const href = `/${slug}/channels/${ch.slug}`;
  const isActive = pathname === href;
  const unread = (ch as { unreadCount?: number }).unreadCount ?? 0;
  const overflow = (ch as { overflow?: boolean }).overflow ?? false;
  const isUnread = unread > 0;
  return (
    <li key={ch._id}>
      <Link
        href={href}
        className={`flex items-center justify-between gap-2 px-2 py-1 rounded text-sm truncate ${
          isActive
            ? "bg-zinc-200 dark:bg-zinc-800 font-medium"
            : "hover:bg-zinc-200 dark:hover:bg-zinc-800"
        } ${isUnread && !isActive ? "font-semibold" : ""}`}
      >
        <span className="truncate">
          {ch.isPrivate ? "🔒" : "#"} {ch.slug}
        </span>
        {isUnread && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-300 dark:bg-zinc-700 text-zinc-800 dark:text-zinc-100">
            {overflow ? "50+" : unread}
          </span>
        )}
      </Link>
    </li>
  );
})}
```

- [ ] **Step 2: Build.**

Run: `npm run build`
Expected: clean.

- [ ] **Step 3: Commit.**

```bash
git add slack-b2b-app/components/messaging/WorkspaceSidebar.tsx
git commit -m "ui: sidebar channels show unread badge + bold when unread"
```

---

## Task 15: Manual E2E — run the 12-step walkthrough

**Files:** none

- [ ] **Step 1: Start Convex + Next in two terminals.**

```bash
# terminal 1
cd slack-b2b-app && npx convex dev
# terminal 2
cd slack-b2b-app && npm run dev
```

- [ ] **Step 2: Run the 12 manual E2E steps from the spec** ([spec §Testing → Manual E2E](../specs/2026-04-23-messaging-polish-design.md)). Use two browsers / profiles as Alice and Bob in the same workspace.

1. Reactions toggle round-trip.
2. Reactions grouping (two users, same emoji → `[👍 2]`; own-reaction style only in reactor's browser).
3. Reactions names via hover tooltip.
4. Reactions disappear on tombstone.
5. Typing shows in the other browser ≤1s.
6. Typing clears on Enter-send immediately.
7. Typing times out ≤6s after last keystroke.
8. Private-channel typing not visible to non-members (verify via Convex Dashboard calling `typing:listForChannel` on a channel the caller doesn't belong to — expect auth error).
9. Unread badge on new messages.
10. Badge clears on click within ~1s.
11. Unread overflow (`50+`) — seed 55 messages via Convex Dashboard from the non-viewer, confirm.
12. Cascade cleanup — admin deletes a non-protected channel; Convex Dashboard confirms 0 rows in `reactions`, `typingIndicators`, `channelReadStates` for that channel.

- [ ] **Step 3: If any step fails, fix the root cause and re-run affected steps. Commit fixes separately** (do not rewrite earlier task commits).

- [ ] **Step 4: When all 12 pass, mark complete** (no commit — there is nothing to check in for this task).

---

## Task 16: Finish — PR + merge + tag

**Files:** none

- [ ] **Step 1: Final full-suite check.**

```bash
cd slack-b2b-app
npm run test
npm run build
```

Expected: all tests green (75 pre-existing + ~17 new = ~92+), clean build.

- [ ] **Step 2: Push the branch.**

```bash
git push -u origin messaging-polish
```

- [ ] **Step 3: Open PR via `gh`.**

```bash
gh pr create --base master --head messaging-polish --title "Messaging polish (M5): reactions, typing, unread" --body "$(cat <<'EOF'
## Summary
- Emoji reactions (6-emoji allowlist) with count pills + hover names
- Typing indicators: 3s heartbeat, 5s expiry, per-channel bar above composer
- Unread counts: per-channel badge on sidebar (bold + `N` / `50+`), mark-read on open + at-bottom

## Spec
docs/superpowers/specs/2026-04-23-messaging-polish-design.md

## Test plan
- [x] Full Convex unit suite (~92 tests)
- [x] 12-step manual E2E from spec
- [x] Cascade verification via Convex Dashboard
EOF
)"
```

- [ ] **Step 4: After merging to master, tag the release.**

```bash
git checkout master
git pull
git tag messaging-polish-v1
git push --tags
```

- [ ] **Step 5: Update memory — mark milestone 5 shipped.**

Ask to update `project_current_milestone.md` with the final status (PR #, commit ranges, test count). Memory update is a user-visible step; pause for confirmation.

---

## Self-review (completed at plan-write time)

**Spec coverage:**
- Reactions schema + `toggle` + `listForMessages` → Tasks 1, 2, 3 ✓
- Typing schema + `heartbeat`/`stop`/`listForChannel` → Tasks 1, 4 ✓
- Reads schema + `markRead` → Tasks 1, 5 ✓
- `channels.listMine` extension → Task 6 ✓
- `channels.deleteChannel` cascade → Task 7 ✓
- `clerkSync.deleteMembership` cascade → Task 8 ✓
- `<ReactionBar>` + `MessageRow` → Task 9 ✓
- Reactions subscription in `MessageList` → Task 10 ✓
- `useTypingHeartbeat` + `MessageComposer` → Task 11 ✓
- `<TypingBar>` + channel page → Task 12 ✓
- `useMarkChannelRead` + `MessageList` → Task 13 ✓
- `WorkspaceSidebar` badge/bold → Task 14 ✓
- Manual E2E (12 steps) → Task 15 ✓
- Finish/tag → Task 16 ✓

**Placeholder scan:** No `TBD` / `TODO` / "implement later" / "similar to" shortcuts. Every step that changes code has the code inline. Every test step has a runnable command with expected outcome.

**Type consistency:**
- `ReactionGroup = {emoji, count, userIds, userNames}` defined in server (Task 3) and client (Task 9) — field names match exactly.
- `listMine`'s return shape gains `{unreadCount, overflow}` in Task 6; sidebar in Task 14 reads those exact fields.
- `useTypingHeartbeat` returns `{onKey, onSend, onBlur, onFocus}` in Task 11; `MessageComposer` wires those exact names.
- `useMarkChannelRead(channelId, atBottom, newestCreationTime)` signature identical in Task 13's creation and the `MessageList` invocation.

Plan is 16 tasks, matches the spec's coverage table.
