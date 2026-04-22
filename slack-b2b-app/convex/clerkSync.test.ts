/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const ISSUER = "https://awaited-boxer-54.clerk.accounts.dev";

// ---------- upsertUser / deleteUser ----------

test("upsertUser inserts a new user", async () => {
  const t = convexTest(schema, modules);
  await t.mutation(internal.clerkSync.upsertUser, {
    data: {
      id: "user_abc",
      email_addresses: [{ email_address: "jane@example.com" }],
      first_name: "Jane",
      last_name: "Doe",
      image_url: "https://example.com/jane.png",
    },
    issuerDomain: ISSUER,
  });

  const users = await t.run(
    async (ctx) => await ctx.db.query("users").collect(),
  );
  expect(users).toHaveLength(1);
  expect(users[0].clerkUserId).toBe("user_abc");
  expect(users[0].email).toBe("jane@example.com");
  expect(users[0].name).toBe("Jane Doe");
  expect(users[0].tokenIdentifier).toBe(`${ISSUER}|user_abc`);
});

test("upsertUser is idempotent", async () => {
  const t = convexTest(schema, modules);
  const args = {
    data: {
      id: "user_abc",
      email_addresses: [{ email_address: "jane@example.com" }],
      first_name: "Jane",
      last_name: "Doe",
    },
    issuerDomain: ISSUER,
  };
  await t.mutation(internal.clerkSync.upsertUser, args);
  await t.mutation(internal.clerkSync.upsertUser, args);

  const users = await t.run(
    async (ctx) => await ctx.db.query("users").collect(),
  );
  expect(users).toHaveLength(1);
});

test("upsertUser updates fields on a second call (profile edit)", async () => {
  const t = convexTest(schema, modules);
  await t.mutation(internal.clerkSync.upsertUser, {
    data: {
      id: "user_abc",
      email_addresses: [{ email_address: "jane@example.com" }],
      first_name: "Jane",
      last_name: "Doe",
    },
    issuerDomain: ISSUER,
  });
  await t.mutation(internal.clerkSync.upsertUser, {
    data: {
      id: "user_abc",
      email_addresses: [{ email_address: "jane.new@example.com" }],
      first_name: "Jane",
      last_name: "Smith",
    },
    issuerDomain: ISSUER,
  });

  const users = await t.run(
    async (ctx) => await ctx.db.query("users").collect(),
  );
  expect(users).toHaveLength(1);
  expect(users[0].email).toBe("jane.new@example.com");
  expect(users[0].name).toBe("Jane Smith");
});

test("deleteUser removes the user and cascades memberships", async () => {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      clerkUserId: "user_abc",
      tokenIdentifier: `${ISSUER}|user_abc`,
      email: "jane@example.com",
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
      role: "org:member",
    });
  });

  await t.mutation(internal.clerkSync.deleteUser, { clerkUserId: "user_abc" });

  expect(
    await t.run(async (ctx) => await ctx.db.query("users").collect()),
  ).toHaveLength(0);
  expect(
    await t.run(async (ctx) => await ctx.db.query("memberships").collect()),
  ).toHaveLength(0);
});

// ---------- upsertOrganization / deleteOrganization ----------

test("upsertOrganization inserts then updates", async () => {
  const t = convexTest(schema, modules);
  await t.mutation(internal.clerkSync.upsertOrganization, {
    data: { id: "org_1", slug: "acme", name: "Acme", image_url: null },
  });
  await t.mutation(internal.clerkSync.upsertOrganization, {
    data: {
      id: "org_1",
      slug: "acme-corp",
      name: "Acme Corp",
      image_url: null,
    },
  });

  const orgs = await t.run(
    async (ctx) => await ctx.db.query("organizations").collect(),
  );
  expect(orgs).toHaveLength(1);
  expect(orgs[0].slug).toBe("acme-corp");
  expect(orgs[0].name).toBe("Acme Corp");
});

test("deleteOrganization removes org and cascades memberships", async () => {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      clerkUserId: "user_abc",
      tokenIdentifier: `${ISSUER}|user_abc`,
      email: "jane@example.com",
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

  await t.mutation(internal.clerkSync.deleteOrganization, {
    clerkOrgId: "org_1",
  });

  expect(
    await t.run(async (ctx) => await ctx.db.query("organizations").collect()),
  ).toHaveLength(0);
  expect(
    await t.run(async (ctx) => await ctx.db.query("memberships").collect()),
  ).toHaveLength(0);
});

// ---------- upsertMembership / deleteMembership ----------

test("upsertMembership inserts when user+org exist", async () => {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    await ctx.db.insert("users", {
      clerkUserId: "user_abc",
      tokenIdentifier: `${ISSUER}|user_abc`,
      email: "jane@example.com",
    });
    await ctx.db.insert("organizations", {
      clerkOrgId: "org_1",
      slug: "acme",
      name: "Acme",
    });
  });

  await t.mutation(internal.clerkSync.upsertMembership, {
    data: {
      id: "orgmem_1",
      organization: { id: "org_1" },
      public_user_data: { user_id: "user_abc" },
      role: "org:admin",
    },
    attempts: 0,
  });

  const mems = await t.run(
    async (ctx) => await ctx.db.query("memberships").collect(),
  );
  expect(mems).toHaveLength(1);
  expect(mems[0].role).toBe("org:admin");
  expect(mems[0].clerkMembershipId).toBe("orgmem_1");
});

test("upsertMembership is idempotent and reflects role change", async () => {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    await ctx.db.insert("users", {
      clerkUserId: "user_abc",
      tokenIdentifier: `${ISSUER}|user_abc`,
      email: "jane@example.com",
    });
    await ctx.db.insert("organizations", {
      clerkOrgId: "org_1",
      slug: "acme",
      name: "Acme",
    });
  });
  const base = {
    data: {
      id: "orgmem_1",
      organization: { id: "org_1" },
      public_user_data: { user_id: "user_abc" },
      role: "org:member",
    },
    attempts: 0,
  };
  await t.mutation(internal.clerkSync.upsertMembership, base);
  await t.mutation(internal.clerkSync.upsertMembership, {
    ...base,
    data: { ...base.data, role: "org:admin" },
  });

  const mems = await t.run(
    async (ctx) => await ctx.db.query("memberships").collect(),
  );
  expect(mems).toHaveLength(1);
  expect(mems[0].role).toBe("org:admin");
});

test("upsertMembership gives up after MAX_MEMBERSHIP_RETRIES when parents are missing", async () => {
  const t = convexTest(schema, modules);
  await t.mutation(internal.clerkSync.upsertMembership, {
    data: {
      id: "orgmem_1",
      organization: { id: "org_missing" },
      public_user_data: { user_id: "user_missing" },
      role: "org:member",
    },
    attempts: 5,
  });

  expect(
    await t.run(async (ctx) => await ctx.db.query("memberships").collect()),
  ).toHaveLength(0);
});

test("deleteMembership removes the row", async () => {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      clerkUserId: "user_abc",
      tokenIdentifier: `${ISSUER}|user_abc`,
      email: "jane@example.com",
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

  await t.mutation(internal.clerkSync.deleteMembership, {
    clerkMembershipId: "orgmem_1",
  });

  expect(
    await t.run(async (ctx) => await ctx.db.query("memberships").collect()),
  ).toHaveLength(0);
});
