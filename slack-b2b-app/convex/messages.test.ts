/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const ISSUER = "https://awaited-boxer-54.clerk.accounts.dev";
const TOKEN = `${ISSUER}|user_abc`;

async function seedAcmeWithGeneral(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      clerkUserId: "user_abc",
      tokenIdentifier: TOKEN,
      email: "jane@example.com",
      name: "Jane Doe",
    });
    const orgId = await ctx.db.insert("organizations", {
      clerkOrgId: "org_1",
      slug: "acme",
      name: "Acme",
    });
    await ctx.db.insert("memberships", {
      userId,
      organizationId: orgId,
      clerkMembershipId: "orgmem_1",
      role: "org:admin",
    });
    const channelId = await ctx.db.insert("channels", {
      organizationId: orgId,
      slug: "general",
      name: "General",
      createdBy: userId,
      isProtected: true,
    });
    await ctx.db.insert("channelMembers", {
      channelId,
      userId,
      organizationId: orgId,
    });
    return { userId, orgId, channelId };
  });
}

// ---------- send ----------

test("messages.send inserts a message by a channel member", async () => {
  const t = convexTest(schema, modules);
  const { channelId } = await seedAcmeWithGeneral(t);

  const asJane = t.withIdentity({
    tokenIdentifier: TOKEN,
    subject: "user_abc",
    email: "jane@example.com",
  });
  await asJane.mutation(api.messages.send, {
    channelId,
    text: "hello world",
  });

  const msgs = await t.run(
    async (ctx) => await ctx.db.query("messages").collect(),
  );
  expect(msgs).toHaveLength(1);
  expect(msgs[0].text).toBe("hello world");
  expect(msgs[0].deletedAt).toBeUndefined();
});

test("messages.send trims text", async () => {
  const t = convexTest(schema, modules);
  const { channelId } = await seedAcmeWithGeneral(t);

  const asJane = t.withIdentity({
    tokenIdentifier: TOKEN,
    subject: "user_abc",
    email: "jane@example.com",
  });
  await asJane.mutation(api.messages.send, {
    channelId,
    text: "   hello   ",
  });

  const msgs = await t.run(
    async (ctx) => await ctx.db.query("messages").collect(),
  );
  expect(msgs[0].text).toBe("hello");
});

test("messages.send rejects empty/whitespace-only text", async () => {
  const t = convexTest(schema, modules);
  const { channelId } = await seedAcmeWithGeneral(t);
  const asJane = t.withIdentity({
    tokenIdentifier: TOKEN,
    subject: "user_abc",
    email: "jane@example.com",
  });
  await expect(
    asJane.mutation(api.messages.send, { channelId, text: "   " }),
  ).rejects.toThrow(/empty/i);
});

test("messages.send rejects text over 4000 chars", async () => {
  const t = convexTest(schema, modules);
  const { channelId } = await seedAcmeWithGeneral(t);
  const asJane = t.withIdentity({
    tokenIdentifier: TOKEN,
    subject: "user_abc",
    email: "jane@example.com",
  });
  await expect(
    asJane.mutation(api.messages.send, {
      channelId,
      text: "x".repeat(4001),
    }),
  ).rejects.toThrow(/4000|length/i);
});

test("messages.send rejects non-channel-member", async () => {
  const t = convexTest(schema, modules);
  const { channelId } = await seedAcmeWithGeneral(t);
  const asIntruder = t.withIdentity({
    tokenIdentifier: `${ISSUER}|user_intruder`,
    subject: "user_intruder",
    email: "intruder@example.com",
  });
  await expect(
    asIntruder.mutation(api.messages.send, {
      channelId,
      text: "hello",
    }),
  ).rejects.toThrow(/Not a channel member/);
});
