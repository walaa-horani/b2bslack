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
