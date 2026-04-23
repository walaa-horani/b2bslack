/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const ISSUER = "https://awaited-boxer-54.clerk.accounts.dev";
const TOKEN = `${ISSUER}|user_abc`;

async function seedAcme(t: ReturnType<typeof convexTest>) {
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
    return { userId, orgId };
  });
}

test("channels.create inserts channel + creator's channelMembers row", async () => {
  const t = convexTest(schema, modules);
  await seedAcme(t);
  const asJane = t.withIdentity({
    tokenIdentifier: TOKEN,
    subject: "user_abc",
    email: "jane@example.com",
  });

  await asJane.mutation(api.channels.create, {
    workspaceSlug: "acme",
    name: "Project Alpha",
    slug: "project-alpha",
  });

  const channels = await t.run(
    async (ctx) => await ctx.db.query("channels").collect(),
  );
  expect(channels).toHaveLength(1);
  expect(channels[0].slug).toBe("project-alpha");
  expect(channels[0].name).toBe("Project Alpha");
  expect(channels[0].isProtected).toBe(false);

  const cmembers = await t.run(
    async (ctx) => await ctx.db.query("channelMembers").collect(),
  );
  expect(cmembers).toHaveLength(1);
  expect(cmembers[0].channelId).toBe(channels[0]._id);
});

test("channels.create rejects duplicate slug in same workspace", async () => {
  const t = convexTest(schema, modules);
  await seedAcme(t);
  const asJane = t.withIdentity({
    tokenIdentifier: TOKEN,
    subject: "user_abc",
    email: "jane@example.com",
  });

  await asJane.mutation(api.channels.create, {
    workspaceSlug: "acme",
    name: "Project Alpha",
    slug: "project-alpha",
  });
  await expect(
    asJane.mutation(api.channels.create, {
      workspaceSlug: "acme",
      name: "Different display",
      slug: "project-alpha",
    }),
  ).rejects.toThrow(/taken|exists|duplicate/i);
});

test("channels.create rejects invalid slug format", async () => {
  const t = convexTest(schema, modules);
  await seedAcme(t);
  const asJane = t.withIdentity({
    tokenIdentifier: TOKEN,
    subject: "user_abc",
    email: "jane@example.com",
  });

  await expect(
    asJane.mutation(api.channels.create, {
      workspaceSlug: "acme",
      name: "Bad Name",
      slug: "Has Spaces",
    }),
  ).rejects.toThrow(/slug/i);
});

test("channels.create rejects non-workspace-member", async () => {
  const t = convexTest(schema, modules);
  await seedAcme(t);
  // Jane is in Acme. Bob is not.
  const asBob = t.withIdentity({
    tokenIdentifier: `${ISSUER}|user_bob`,
    subject: "user_bob",
    email: "bob@example.com",
  });

  await expect(
    asBob.mutation(api.channels.create, {
      workspaceSlug: "acme",
      name: "Intruder",
      slug: "intruder",
    }),
  ).rejects.toThrow(/Not a member/);
});

// ---------- join / leave ----------

test("channels.join adds a channelMembers row (idempotent)", async () => {
  const t = convexTest(schema, modules);
  const { userId: janeId, orgId } = await seedAcme(t);

  // Add Bob as a workspace member.
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
      role: "org:member",
    });
    return { bobId };
  });

  // Jane creates #project-alpha.
  const asJane = t.withIdentity({
    tokenIdentifier: TOKEN,
    subject: "user_abc",
    email: "jane@example.com",
  });
  const channelId = await asJane.mutation(api.channels.create, {
    workspaceSlug: "acme",
    name: "Project Alpha",
    slug: "project-alpha",
  });

  // Bob joins.
  const asBob = t.withIdentity({
    tokenIdentifier: `${ISSUER}|user_bob`,
    subject: "user_bob",
    email: "bob@example.com",
  });
  await asBob.mutation(api.channels.join, { channelId });
  await asBob.mutation(api.channels.join, { channelId }); // idempotent

  const bobMemberships = await t.run(
    async (ctx) =>
      await ctx.db
        .query("channelMembers")
        .withIndex("by_user_and_channel", (q) =>
          q.eq("userId", bobId).eq("channelId", channelId),
        )
        .collect(),
  );
  expect(bobMemberships).toHaveLength(1);
});

test("channels.join rejects non-workspace-member", async () => {
  const t = convexTest(schema, modules);
  const { userId: janeId, orgId } = await seedAcme(t);
  const asJane = t.withIdentity({
    tokenIdentifier: TOKEN,
    subject: "user_abc",
    email: "jane@example.com",
  });
  const channelId = await asJane.mutation(api.channels.create, {
    workspaceSlug: "acme",
    name: "Project Alpha",
    slug: "project-alpha",
  });

  const asIntruder = t.withIdentity({
    tokenIdentifier: `${ISSUER}|user_intruder`,
    subject: "user_intruder",
    email: "intruder@example.com",
  });
  await expect(
    asIntruder.mutation(api.channels.join, { channelId }),
  ).rejects.toThrow(/Not a member/);
});

test("channels.leave removes the caller's channelMembers row", async () => {
  const t = convexTest(schema, modules);
  const { userId: janeId, orgId } = await seedAcme(t);
  const asJane = t.withIdentity({
    tokenIdentifier: TOKEN,
    subject: "user_abc",
    email: "jane@example.com",
  });
  const channelId = await asJane.mutation(api.channels.create, {
    workspaceSlug: "acme",
    name: "Project Alpha",
    slug: "project-alpha",
  });

  await asJane.mutation(api.channels.leave, { channelId });

  const remaining = await t.run(
    async (ctx) =>
      await ctx.db
        .query("channelMembers")
        .withIndex("by_channel", (q) => q.eq("channelId", channelId))
        .collect(),
  );
  expect(remaining).toHaveLength(0);
});

test("channels.leave throws on protected channel (#general)", async () => {
  const t = convexTest(schema, modules);
  const { userId, orgId } = await seedAcme(t);
  const generalId = await t.run(async (ctx) => {
    const id = await ctx.db.insert("channels", {
      organizationId: orgId,
      slug: "general",
      name: "General",
      createdBy: userId,
      isProtected: true,
    });
    await ctx.db.insert("channelMembers", {
      channelId: id,
      userId,
      organizationId: orgId,
    });
    return id;
  });

  const asJane = t.withIdentity({
    tokenIdentifier: TOKEN,
    subject: "user_abc",
    email: "jane@example.com",
  });
  await expect(
    asJane.mutation(api.channels.leave, { channelId: generalId }),
  ).rejects.toThrow(/Cannot leave/i);
});

// ---------- deleteChannel ----------

test("channels.deleteChannel by admin cascades messages + channelMembers", async () => {
  const t = convexTest(schema, modules);
  const { userId, orgId } = await seedAcme(t);
  const asJane = t.withIdentity({
    tokenIdentifier: TOKEN,
    subject: "user_abc",
    email: "jane@example.com",
  });
  const channelId = await asJane.mutation(api.channels.create, {
    workspaceSlug: "acme",
    name: "Project Alpha",
    slug: "project-alpha",
  });
  await t.run(async (ctx) => {
    await ctx.db.insert("messages", {
      channelId,
      userId,
      text: "hello",
    });
  });

  await asJane.mutation(api.channels.deleteChannel, { channelId });

  expect(
    await t.run(
      async (ctx) =>
        await ctx.db
          .query("channels")
          .withIndex("by_organization", (q) => q.eq("organizationId", orgId))
          .collect(),
    ),
  ).toHaveLength(0);
  expect(
    await t.run(async (ctx) => await ctx.db.query("messages").collect()),
  ).toHaveLength(0);
  expect(
    await t.run(async (ctx) => await ctx.db.query("channelMembers").collect()),
  ).toHaveLength(0);
});

test("channels.deleteChannel rejects non-admin", async () => {
  const t = convexTest(schema, modules);
  const { userId: janeId, orgId } = await seedAcme(t);

  // Bob is a member (not admin).
  await t.run(async (ctx) => {
    const bobId = await ctx.db.insert("users", {
      clerkUserId: "user_bob",
      tokenIdentifier: `${ISSUER}|user_bob`,
      email: "bob@example.com",
    });
    await ctx.db.insert("memberships", {
      userId: bobId,
      organizationId: orgId,
      clerkMembershipId: "orgmem_bob",
      role: "org:member",
    });
  });

  const asJane = t.withIdentity({
    tokenIdentifier: TOKEN,
    subject: "user_abc",
    email: "jane@example.com",
  });
  const channelId = await asJane.mutation(api.channels.create, {
    workspaceSlug: "acme",
    name: "Project Alpha",
    slug: "project-alpha",
  });

  const asBob = t.withIdentity({
    tokenIdentifier: `${ISSUER}|user_bob`,
    subject: "user_bob",
    email: "bob@example.com",
  });
  await expect(
    asBob.mutation(api.channels.deleteChannel, { channelId }),
  ).rejects.toThrow(/admin/i);
});

test("channels.deleteChannel throws on protected channel", async () => {
  const t = convexTest(schema, modules);
  const { userId, orgId } = await seedAcme(t);
  const generalId = await t.run(async (ctx) => {
    return await ctx.db.insert("channels", {
      organizationId: orgId,
      slug: "general",
      name: "General",
      createdBy: userId,
      isProtected: true,
    });
  });
  const asJane = t.withIdentity({
    tokenIdentifier: TOKEN,
    subject: "user_abc",
    email: "jane@example.com",
  });
  await expect(
    asJane.mutation(api.channels.deleteChannel, { channelId: generalId }),
  ).rejects.toThrow(/protected|cannot delete/i);
});

// ---------- queries ----------

test("channels.listMine returns only channels the caller belongs to", async () => {
  const t = convexTest(schema, modules);
  const { userId, orgId } = await seedAcme(t);
  await t.run(async (ctx) => {
    // Jane is a member of #general but NOT #random.
    const generalId = await ctx.db.insert("channels", {
      organizationId: orgId,
      slug: "general",
      name: "General",
      createdBy: userId,
      isProtected: true,
    });
    await ctx.db.insert("channels", {
      organizationId: orgId,
      slug: "random",
      name: "Random",
      createdBy: userId,
      isProtected: false,
    });
    await ctx.db.insert("channelMembers", {
      channelId: generalId,
      userId,
      organizationId: orgId,
    });
  });

  const asJane = t.withIdentity({
    tokenIdentifier: TOKEN,
    subject: "user_abc",
    email: "jane@example.com",
  });
  const mine = await asJane.query(api.channels.listMine, {
    workspaceSlug: "acme",
  });
  expect(mine).toHaveLength(1);
  expect(mine[0].slug).toBe("general");
});

test("channels.getBySlug returns channel + membership for a member", async () => {
  const t = convexTest(schema, modules);
  const { userId, orgId } = await seedAcme(t);
  await t.run(async (ctx) => {
    const generalId = await ctx.db.insert("channels", {
      organizationId: orgId,
      slug: "general",
      name: "General",
      createdBy: userId,
      isProtected: true,
    });
    await ctx.db.insert("channelMembers", {
      channelId: generalId,
      userId,
      organizationId: orgId,
    });
  });

  const asJane = t.withIdentity({
    tokenIdentifier: TOKEN,
    subject: "user_abc",
    email: "jane@example.com",
  });
  const result = await asJane.query(api.channels.getBySlug, {
    workspaceSlug: "acme",
    channelSlug: "general",
  });
  expect(result.channel.slug).toBe("general");
  expect(result.channel.isProtected).toBe(true);
});

test("channels.getBySlug throws for non-member", async () => {
  const t = convexTest(schema, modules);
  const { userId, orgId } = await seedAcme(t);
  await t.run(async (ctx) => {
    await ctx.db.insert("channels", {
      organizationId: orgId,
      slug: "secret",
      name: "Secret",
      createdBy: userId,
      isProtected: false,
    });
    // No channelMembers row.
  });

  const asJane = t.withIdentity({
    tokenIdentifier: TOKEN,
    subject: "user_abc",
    email: "jane@example.com",
  });
  await expect(
    asJane.query(api.channels.getBySlug, {
      workspaceSlug: "acme",
      channelSlug: "secret",
    }),
  ).rejects.toThrow(/Not a channel member/);
});

test("channels.listBrowsable returns channels the caller is NOT in", async () => {
  const t = convexTest(schema, modules);
  const { userId, orgId } = await seedAcme(t);
  await t.run(async (ctx) => {
    const generalId = await ctx.db.insert("channels", {
      organizationId: orgId,
      slug: "general",
      name: "General",
      createdBy: userId,
      isProtected: true,
    });
    await ctx.db.insert("channels", {
      organizationId: orgId,
      slug: "random",
      name: "Random",
      createdBy: userId,
      isProtected: false,
    });
    await ctx.db.insert("channelMembers", {
      channelId: generalId,
      userId,
      organizationId: orgId,
    });
  });

  const asJane = t.withIdentity({
    tokenIdentifier: TOKEN,
    subject: "user_abc",
    email: "jane@example.com",
  });
  const browsable = await asJane.query(api.channels.listBrowsable, {
    workspaceSlug: "acme",
  });
  expect(browsable).toHaveLength(1);
  expect(browsable[0].slug).toBe("random");
});
