/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const ISSUER = "https://awaited-boxer-54.clerk.accounts.dev";
const TOKEN = `${ISSUER}|user_abc`;

test("ensureUser inserts a user row when the identity is new", async () => {
  const t = convexTest(schema, modules);
  const asJane = t.withIdentity({
    tokenIdentifier: TOKEN,
    subject: "user_abc",
    email: "jane@example.com",
    name: "Jane Doe",
    pictureUrl: "https://example.com/jane.png",
  });

  const user = await asJane.mutation(api.users.ensureUser, {});
  expect(user.email).toBe("jane@example.com");
  expect(user.name).toBe("Jane Doe");

  const rows = await t.run(
    async (ctx) => await ctx.db.query("users").collect(),
  );
  expect(rows).toHaveLength(1);
  expect(rows[0].clerkUserId).toBe("user_abc");
  expect(rows[0].tokenIdentifier).toBe(TOKEN);
});

test("ensureUser is idempotent — two calls return the same row", async () => {
  const t = convexTest(schema, modules);
  const asJane = t.withIdentity({
    tokenIdentifier: TOKEN,
    subject: "user_abc",
    email: "jane@example.com",
  });

  const first = await asJane.mutation(api.users.ensureUser, {});
  const second = await asJane.mutation(api.users.ensureUser, {});
  expect(first._id).toEqual(second._id);

  const rows = await t.run(
    async (ctx) => await ctx.db.query("users").collect(),
  );
  expect(rows).toHaveLength(1);
});

test("whoami returns null when user row hasn't been synced", async () => {
  const t = convexTest(schema, modules);
  const asJane = t.withIdentity({
    tokenIdentifier: TOKEN,
    subject: "user_abc",
    email: "jane@example.com",
  });
  expect(await asJane.query(api.workspace.whoami, {})).toBeNull();
});

test("whoami returns the user when row exists", async () => {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    await ctx.db.insert("users", {
      clerkUserId: "user_abc",
      tokenIdentifier: TOKEN,
      email: "jane@example.com",
      name: "Jane Doe",
    });
  });
  const asJane = t.withIdentity({
    tokenIdentifier: TOKEN,
    subject: "user_abc",
    email: "jane@example.com",
  });
  const me = await asJane.query(api.workspace.whoami, {});
  expect(me?.email).toBe("jane@example.com");
  expect(me?.name).toBe("Jane Doe");
});

test("getOverview returns org + user + role for a member", async () => {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
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
  });

  const asJane = t.withIdentity({
    tokenIdentifier: TOKEN,
    subject: "user_abc",
    email: "jane@example.com",
  });
  const overview = await asJane.query(api.workspace.getOverview, {
    slug: "acme",
  });
  expect(overview).toMatchObject({
    orgName: "Acme",
    orgSlug: "acme",
    userName: "Jane Doe",
    role: "org:admin",
    planKey: null,
  });
  // Free features by default (no planKey set).
  expect(overview.features).toEqual(
    expect.arrayContaining(["public_channels", "basic_messaging"]),
  );
});

test("getOverview returns planKey + Pro features for a Pro org", async () => {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
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
      planKey: "pro",
    });
    await ctx.db.insert("memberships", {
      userId,
      organizationId: orgId,
      clerkMembershipId: "orgmem_1",
      role: "org:admin",
    });
  });

  const asJane = t.withIdentity({
    tokenIdentifier: TOKEN,
    subject: "user_abc",
    email: "jane@example.com",
  });
  const overview = await asJane.query(api.workspace.getOverview, {
    slug: "acme",
  });
  expect(overview.planKey).toBe("pro");
  expect(overview.features).toEqual(
    expect.arrayContaining([
      "public_channels",
      "basic_messaging",
      "private_channels",
      "unlimited_message_history",
    ]),
  );
});

test("getOverview throws for non-member when org exists", async () => {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    await ctx.db.insert("users", {
      clerkUserId: "user_abc",
      tokenIdentifier: TOKEN,
      email: "jane@example.com",
    });
    await ctx.db.insert("organizations", {
      clerkOrgId: "org_1",
      slug: "acme",
      name: "Acme",
    });
    // intentionally no membership row
  });
  const asJane = t.withIdentity({
    tokenIdentifier: TOKEN,
    subject: "user_abc",
    email: "jane@example.com",
  });
  await expect(
    asJane.query(api.workspace.getOverview, { slug: "acme" }),
  ).rejects.toThrow(/Not a member/);
});

test("getOverview throws for unknown workspace slug", async () => {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    await ctx.db.insert("users", {
      clerkUserId: "user_abc",
      tokenIdentifier: TOKEN,
      email: "jane@example.com",
    });
  });
  const asJane = t.withIdentity({
    tokenIdentifier: TOKEN,
    subject: "user_abc",
    email: "jane@example.com",
  });
  await expect(
    asJane.query(api.workspace.getOverview, { slug: "nonexistent" }),
  ).rejects.toThrow(/Unknown workspace/);
});

// ---------- listMembers (R10) ----------

test("workspace.listMembers returns all members with user info", async () => {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    const janeId = await ctx.db.insert("users", {
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
      userId: janeId,
      organizationId: orgId,
      clerkMembershipId: "orgmem_1",
      role: "org:admin",
    });
    const bobId = await ctx.db.insert("users", {
      clerkUserId: "user_bob",
      tokenIdentifier: `${ISSUER}|user_bob`,
      email: "bob@example.com",
      name: "Bob",
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
  const members = await asJane.query(api.workspace.listMembers, {
    workspaceSlug: "acme",
  });
  expect(members).toHaveLength(2);
  const names = members.map((m) => m.user.name).sort();
  expect(names).toEqual(["Bob", "Jane Doe"]);
  expect(members.find((m) => m.user.name === "Jane Doe")?.role).toBe("org:admin");
  expect(members.find((m) => m.user.name === "Bob")?.role).toBe("org:member");
});

test("workspace.listMembers rejects non-members", async () => {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    await ctx.db.insert("organizations", {
      clerkOrgId: "org_1",
      slug: "acme",
      name: "Acme",
    });
  });
  const asStranger = t.withIdentity({
    tokenIdentifier: `${ISSUER}|user_stranger`,
    subject: "user_stranger",
    email: "stranger@example.com",
  });
  await expect(
    asStranger.query(api.workspace.listMembers, { workspaceSlug: "acme" }),
  ).rejects.toThrow(/authenticated|Not a member/i);
});
