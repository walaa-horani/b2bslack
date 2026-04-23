/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
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
  const { channelId, bobId } = await seedChannelWithTwoMembersAndMessage(t);
  const realIds = await t.run(async (ctx) => {
    const ids: Id<"messages">[] = [];
    for (let i = 0; i < 301; i++) {
      ids.push(
        await ctx.db.insert("messages", { channelId, userId: bobId, text: `msg${i}` }),
      );
    }
    return ids;
  });
  await expect(
    asAlice(t).query(api.reactions.listForMessages, { messageIds: realIds }),
  ).rejects.toThrow(/too many/i);
});
