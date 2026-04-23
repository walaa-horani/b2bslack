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
