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
