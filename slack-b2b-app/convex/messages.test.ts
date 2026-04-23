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

// ---------- list ----------

test("messages.list returns paginated messages with author info, newest-first", async () => {
  const t = convexTest(schema, modules);
  const { userId, channelId } = await seedAcmeWithGeneral(t);
  await t.run(async (ctx) => {
    for (let i = 0; i < 5; i++) {
      await ctx.db.insert("messages", {
        channelId,
        userId,
        text: `msg ${i}`,
      });
    }
  });

  const asJane = t.withIdentity({
    tokenIdentifier: TOKEN,
    subject: "user_abc",
    email: "jane@example.com",
  });
  const page = await asJane.query(api.messages.list, {
    channelId,
    paginationOpts: { numItems: 3, cursor: null },
  });

  expect(page.page).toHaveLength(3);
  // Newest first (desc _creationTime). Last-inserted is msg 4.
  expect(page.page[0].message.text).toBe("msg 4");
  expect(page.page[2].message.text).toBe("msg 2");
  expect(page.page[0].author.name).toBe("Jane Doe");
  expect(page.isDone).toBe(false);
});

test("messages.list paginates via continueCursor", async () => {
  const t = convexTest(schema, modules);
  const { userId, channelId } = await seedAcmeWithGeneral(t);
  await t.run(async (ctx) => {
    for (let i = 0; i < 7; i++) {
      await ctx.db.insert("messages", {
        channelId,
        userId,
        text: `msg ${i}`,
      });
    }
  });

  const asJane = t.withIdentity({
    tokenIdentifier: TOKEN,
    subject: "user_abc",
    email: "jane@example.com",
  });
  const p1 = await asJane.query(api.messages.list, {
    channelId,
    paginationOpts: { numItems: 3, cursor: null },
  });
  const p2 = await asJane.query(api.messages.list, {
    channelId,
    paginationOpts: { numItems: 3, cursor: p1.continueCursor },
  });
  const p3 = await asJane.query(api.messages.list, {
    channelId,
    paginationOpts: { numItems: 3, cursor: p2.continueCursor },
  });

  expect(p1.page).toHaveLength(3);
  expect(p2.page).toHaveLength(3);
  expect(p3.page).toHaveLength(1);
  expect(p3.isDone).toBe(true);
});

test("messages.list throws for non-channel-member", async () => {
  const t = convexTest(schema, modules);
  const { channelId } = await seedAcmeWithGeneral(t);
  const asIntruder = t.withIdentity({
    tokenIdentifier: `${ISSUER}|user_intruder`,
    subject: "user_intruder",
    email: "intruder@example.com",
  });
  await expect(
    asIntruder.query(api.messages.list, {
      channelId,
      paginationOpts: { numItems: 30, cursor: null },
    }),
  ).rejects.toThrow(/Not a channel member/);
});

// ---------- deleteMessage ----------

test("messages.deleteMessage sets deletedAt on own message", async () => {
  const t = convexTest(schema, modules);
  const { channelId } = await seedAcmeWithGeneral(t);
  const asJane = t.withIdentity({
    tokenIdentifier: TOKEN,
    subject: "user_abc",
    email: "jane@example.com",
  });
  const messageId = await asJane.mutation(api.messages.send, {
    channelId,
    text: "oops",
  });

  const before = Date.now();
  await asJane.mutation(api.messages.deleteMessage, { messageId });
  const after = Date.now();

  const row = await t.run(async (ctx) => await ctx.db.get(messageId));
  expect(row?.deletedAt).toBeGreaterThanOrEqual(before);
  expect(row?.deletedAt).toBeLessThanOrEqual(after);
  expect(row?.text).toBe("oops"); // text retained
});

test("messages.deleteMessage throws for non-author (even admin)", async () => {
  const t = convexTest(schema, modules);
  const { userId: janeId, orgId, channelId } = await seedAcmeWithGeneral(t);

  // Jane posts.
  const asJane = t.withIdentity({
    tokenIdentifier: TOKEN,
    subject: "user_abc",
    email: "jane@example.com",
  });
  const messageId = await asJane.mutation(api.messages.send, {
    channelId,
    text: "from jane",
  });

  // Bob is another admin in the workspace + channel.
  const { bobId } = await t.run(async (ctx) => {
    const bobId = await ctx.db.insert("users", {
      clerkUserId: "user_bob",
      tokenIdentifier: `${ISSUER}|user_bob`,
      email: "bob@example.com",
    });
    await ctx.db.insert("memberships", {
      userId: bobId,
      organizationId: orgId,
      clerkMembershipId: "orgmem_bob",
      role: "org:admin",
    });
    await ctx.db.insert("channelMembers", {
      channelId,
      userId: bobId,
      organizationId: orgId,
    });
    return { bobId };
  });
  const asBob = t.withIdentity({
    tokenIdentifier: `${ISSUER}|user_bob`,
    subject: "user_bob",
    email: "bob@example.com",
  });

  await expect(
    asBob.mutation(api.messages.deleteMessage, { messageId }),
  ).rejects.toThrow(/author|not authorized/i);
});
