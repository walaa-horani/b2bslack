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
  expect(overview).toEqual({
    orgName: "Acme",
    orgSlug: "acme",
    userName: "Jane Doe",
    role: "org:admin",
  });
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
