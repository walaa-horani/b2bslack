/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const ISSUER = "https://awaited-boxer-54.clerk.accounts.dev";
const TOKEN = `${ISSUER}|user_abc`;

async function seedAcme(
  t: ReturnType<typeof convexTest>,
  opts: { planKey?: string } = {},
) {
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
      planKey: opts.planKey,
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

// ---------- isPrivate gate (R7) ----------

test("channels.create({isPrivate: true}) on Free org throws PaywallError", async () => {
  const t = convexTest(schema, modules);
  await seedAcme(t, { planKey: "free_org" });
  const asJane = t.withIdentity({
    tokenIdentifier: TOKEN,
    subject: "user_abc",
    email: "jane@example.com",
  });

  await expect(
    asJane.mutation(api.channels.create, {
      workspaceSlug: "acme",
      name: "Private Ops",
      slug: "private-ops",
      isPrivate: true,
    }),
  ).rejects.toThrow(/private_channels|upgrade/i);

  expect(
    await t.run(async (ctx) => await ctx.db.query("channels").collect()),
  ).toHaveLength(0);
});

test("channels.create({isPrivate: true}) on Pro org succeeds", async () => {
  const t = convexTest(schema, modules);
  await seedAcme(t, { planKey: "pro" });
  const asJane = t.withIdentity({
    tokenIdentifier: TOKEN,
    subject: "user_abc",
    email: "jane@example.com",
  });

  const id = await asJane.mutation(api.channels.create, {
    workspaceSlug: "acme",
    name: "Private Ops",
    slug: "private-ops",
    isPrivate: true,
  });

  const ch = await t.run(async (ctx) => await ctx.db.get(id));
  expect(ch?.isPrivate).toBe(true);
});

test("channels.create without isPrivate defaults to public on Free", async () => {
  const t = convexTest(schema, modules);
  await seedAcme(t, { planKey: "free_org" });
  const asJane = t.withIdentity({
    tokenIdentifier: TOKEN,
    subject: "user_abc",
    email: "jane@example.com",
  });

  const id = await asJane.mutation(api.channels.create, {
    workspaceSlug: "acme",
    name: "Project Alpha",
    slug: "project-alpha",
  });

  const ch = await t.run(async (ctx) => await ctx.db.get(id));
  expect(ch?.isPrivate).toBe(false);
});

// ---------- invite + listChannelMembers (R8) ----------

test("channels.invite adds a channelMembers row on a private channel (Pro)", async () => {
  const t = convexTest(schema, modules);
  const { orgId } = await seedAcme(t, { planKey: "pro" });

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

  const asJane = t.withIdentity({
    tokenIdentifier: TOKEN,
    subject: "user_abc",
    email: "jane@example.com",
  });
  const channelId = await asJane.mutation(api.channels.create, {
    workspaceSlug: "acme",
    name: "Ops",
    slug: "ops",
    isPrivate: true,
  });

  await asJane.mutation(api.channels.invite, { channelId, userId: bobId });
  await asJane.mutation(api.channels.invite, { channelId, userId: bobId }); // idempotent

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

test("channels.invite on a private channel by a Free caller throws PaywallError", async () => {
  const t = convexTest(schema, modules);
  const { userId: janeId, orgId } = await seedAcme(t, { planKey: "free_org" });

  const { channelId, bobId } = await t.run(async (ctx) => {
    const channelId = await ctx.db.insert("channels", {
      organizationId: orgId,
      slug: "ops",
      name: "Ops",
      createdBy: janeId,
      isProtected: false,
      isPrivate: true,
    });
    await ctx.db.insert("channelMembers", {
      channelId,
      userId: janeId,
      organizationId: orgId,
    });
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
    return { channelId, bobId };
  });

  const asJane = t.withIdentity({
    tokenIdentifier: TOKEN,
    subject: "user_abc",
    email: "jane@example.com",
  });
  await expect(
    asJane.mutation(api.channels.invite, { channelId, userId: bobId }),
  ).rejects.toThrow(/private_channels|upgrade/i);
});

test("channels.invite rejects non-channel-member callers", async () => {
  const t = convexTest(schema, modules);
  const { orgId } = await seedAcme(t, { planKey: "pro" });
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

  const asJane = t.withIdentity({
    tokenIdentifier: TOKEN,
    subject: "user_abc",
    email: "jane@example.com",
  });
  const channelId = await asJane.mutation(api.channels.create, {
    workspaceSlug: "acme",
    name: "Ops",
    slug: "ops",
    isPrivate: true,
  });

  const asBob = t.withIdentity({
    tokenIdentifier: `${ISSUER}|user_bob`,
    subject: "user_bob",
    email: "bob@example.com",
  });
  await expect(
    asBob.mutation(api.channels.invite, { channelId, userId: bobId }),
  ).rejects.toThrow(/Not a channel member/);
});

test("channels.invite rejects non-workspace-member invitee", async () => {
  const t = convexTest(schema, modules);
  await seedAcme(t, { planKey: "pro" });
  const asJane = t.withIdentity({
    tokenIdentifier: TOKEN,
    subject: "user_abc",
    email: "jane@example.com",
  });
  const channelId = await asJane.mutation(api.channels.create, {
    workspaceSlug: "acme",
    name: "Ops",
    slug: "ops",
    isPrivate: true,
  });

  const strangerId = await t.run(async (ctx) =>
    await ctx.db.insert("users", {
      clerkUserId: "user_stranger",
      tokenIdentifier: `${ISSUER}|user_stranger`,
      email: "stranger@example.com",
    }),
  );

  await expect(
    asJane.mutation(api.channels.invite, { channelId, userId: strangerId }),
  ).rejects.toThrow(/Not a member/);
});

test("channels.listChannelMembers returns the set of userIds in the channel", async () => {
  const t = convexTest(schema, modules);
  const { userId: janeId, orgId } = await seedAcme(t, { planKey: "pro" });
  const channelId = await t.run(async (ctx) => {
    const id = await ctx.db.insert("channels", {
      organizationId: orgId,
      slug: "ops",
      name: "Ops",
      createdBy: janeId,
      isProtected: false,
      isPrivate: true,
    });
    await ctx.db.insert("channelMembers", {
      channelId: id,
      userId: janeId,
      organizationId: orgId,
    });
    return id;
  });

  const asJane = t.withIdentity({
    tokenIdentifier: TOKEN,
    subject: "user_abc",
    email: "jane@example.com",
  });
  const result = await asJane.query(api.channels.listChannelMembers, {
    channelId,
  });
  expect(result).toHaveLength(1);
  expect(result[0]).toBe(janeId);
});

// ---------- listBrowsable filter (R9) ----------

test("channels.listBrowsable excludes private channels", async () => {
  const t = convexTest(schema, modules);
  const { userId: janeId, orgId } = await seedAcme(t, { planKey: "pro" });

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
    const publicId = await ctx.db.insert("channels", {
      organizationId: orgId,
      slug: "random",
      name: "Random",
      createdBy: janeId,
      isProtected: false,
      isPrivate: false,
    });
    const privateId = await ctx.db.insert("channels", {
      organizationId: orgId,
      slug: "ops",
      name: "Ops",
      createdBy: janeId,
      isProtected: false,
      isPrivate: true,
    });
    await ctx.db.insert("channelMembers", {
      channelId: publicId,
      userId: janeId,
      organizationId: orgId,
    });
    await ctx.db.insert("channelMembers", {
      channelId: privateId,
      userId: janeId,
      organizationId: orgId,
    });
    return { bobId };
  });

  const asBob = t.withIdentity({
    tokenIdentifier: `${ISSUER}|user_bob`,
    subject: "user_bob",
    email: "bob@example.com",
  });

  const browsable = await asBob.query(api.channels.listBrowsable, {
    workspaceSlug: "acme",
  });
  expect(browsable).toHaveLength(1);
  expect(browsable[0].slug).toBe("random");
  expect(browsable.find((c) => c.slug === "ops")).toBeUndefined();
});

// ---------- seedAcmeWithGeneral helper ----------

async function seedAcmeWithGeneral(
  t: ReturnType<typeof convexTest>,
  opts: { planKey?: string } = {},
) {
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
      planKey: opts.planKey,
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

// ---------- listMine unread counts (Task 6) ----------

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
