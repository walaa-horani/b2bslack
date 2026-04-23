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

// ---------- channel auto-provisioning via upsertMembership ----------

test("upsertMembership auto-creates #general on first membership of a workspace", async () => {
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

  const channels = await t.run(
    async (ctx) => await ctx.db.query("channels").collect(),
  );
  expect(channels).toHaveLength(1);
  expect(channels[0].slug).toBe("general");
  expect(channels[0].name).toBe("General");
  expect(channels[0].isProtected).toBe(true);

  const cmembers = await t.run(
    async (ctx) => await ctx.db.query("channelMembers").collect(),
  );
  expect(cmembers).toHaveLength(1);
  expect(cmembers[0].channelId).toBe(channels[0]._id);
});

test("upsertMembership on a second member does NOT duplicate #general", async () => {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    await ctx.db.insert("users", {
      clerkUserId: "user_a",
      tokenIdentifier: `${ISSUER}|user_a`,
      email: "a@example.com",
    });
    await ctx.db.insert("users", {
      clerkUserId: "user_b",
      tokenIdentifier: `${ISSUER}|user_b`,
      email: "b@example.com",
    });
    await ctx.db.insert("organizations", {
      clerkOrgId: "org_1",
      slug: "acme",
      name: "Acme",
    });
  });
  const baseArgs = {
    data: {
      id: "orgmem_1",
      organization: { id: "org_1" },
      public_user_data: { user_id: "user_a" },
      role: "org:admin",
    },
    attempts: 0,
  };
  await t.mutation(internal.clerkSync.upsertMembership, baseArgs);
  await t.mutation(internal.clerkSync.upsertMembership, {
    ...baseArgs,
    data: {
      ...baseArgs.data,
      id: "orgmem_2",
      public_user_data: { user_id: "user_b" },
      role: "org:member",
    },
  });

  const channels = await t.run(
    async (ctx) => await ctx.db.query("channels").collect(),
  );
  expect(channels).toHaveLength(1);

  const cmembers = await t.run(
    async (ctx) => await ctx.db.query("channelMembers").collect(),
  );
  expect(cmembers).toHaveLength(2); // one per user
});

test("deleteMembership cascades channelMembers within the workspace only", async () => {
  const t = convexTest(schema, modules);
  const { userId, orgAId, orgBId, memAId, memBId, acmeGeneralId, betaGeneralId } =
    await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {
        clerkUserId: "user_abc",
        tokenIdentifier: `${ISSUER}|user_abc`,
        email: "jane@example.com",
      });
      const orgAId = await ctx.db.insert("organizations", {
        clerkOrgId: "org_A",
        slug: "acme",
        name: "Acme",
      });
      const orgBId = await ctx.db.insert("organizations", {
        clerkOrgId: "org_B",
        slug: "beta",
        name: "Beta",
      });
      const memAId = await ctx.db.insert("memberships", {
        userId,
        organizationId: orgAId,
        clerkMembershipId: "orgmem_A",
        role: "org:admin",
      });
      const memBId = await ctx.db.insert("memberships", {
        userId,
        organizationId: orgBId,
        clerkMembershipId: "orgmem_B",
        role: "org:member",
      });
      const acmeGeneralId = await ctx.db.insert("channels", {
        organizationId: orgAId,
        slug: "general",
        name: "General",
        createdBy: userId,
        isProtected: true,
      });
      const betaGeneralId = await ctx.db.insert("channels", {
        organizationId: orgBId,
        slug: "general",
        name: "General",
        createdBy: userId,
        isProtected: true,
      });
      await ctx.db.insert("channelMembers", {
        userId,
        channelId: acmeGeneralId,
        organizationId: orgAId,
      });
      await ctx.db.insert("channelMembers", {
        userId,
        channelId: betaGeneralId,
        organizationId: orgBId,
      });
      return { userId, orgAId, orgBId, memAId, memBId, acmeGeneralId, betaGeneralId };
    });

  // Delete the Acme membership only.
  await t.mutation(internal.clerkSync.deleteMembership, {
    clerkMembershipId: "orgmem_A",
  });

  const cmembers = await t.run(
    async (ctx) => await ctx.db.query("channelMembers").collect(),
  );
  expect(cmembers).toHaveLength(1);
  expect(cmembers[0].organizationId).toBe(orgBId); // Beta membership still here
});

test("deleteMembership cascades reactions, typingIndicators, channelReadStates within the workspace only", async () => {
  const t = convexTest(schema, modules);
  const seeded = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      clerkUserId: "user_leave",
      tokenIdentifier: `${ISSUER}|user_leave`,
      email: "l@e.com",
      name: "L",
    });
    const orgA = await ctx.db.insert("organizations", {
      clerkOrgId: "org_A",
      slug: "acme",
      name: "A",
    });
    const orgB = await ctx.db.insert("organizations", {
      clerkOrgId: "org_B",
      slug: "bee",
      name: "B",
    });
    await ctx.db.insert("memberships", {
      userId,
      organizationId: orgA,
      clerkMembershipId: "mem_a",
      role: "org:member",
    });
    await ctx.db.insert("memberships", {
      userId,
      organizationId: orgB,
      clerkMembershipId: "mem_b",
      role: "org:member",
    });
    const chA = await ctx.db.insert("channels", {
      organizationId: orgA,
      slug: "general",
      name: "General",
      createdBy: userId,
      isProtected: true,
    });
    const chB = await ctx.db.insert("channels", {
      organizationId: orgB,
      slug: "general",
      name: "General",
      createdBy: userId,
      isProtected: true,
    });
    await ctx.db.insert("channelMembers", { channelId: chA, userId, organizationId: orgA });
    await ctx.db.insert("channelMembers", { channelId: chB, userId, organizationId: orgB });
    const msgA = await ctx.db.insert("messages", { channelId: chA, userId, text: "hi" });
    const msgB = await ctx.db.insert("messages", { channelId: chB, userId, text: "hi" });
    await ctx.db.insert("reactions", { messageId: msgA, userId, emoji: "👍", channelId: chA });
    await ctx.db.insert("reactions", { messageId: msgB, userId, emoji: "👍", channelId: chB });
    await ctx.db.insert("typingIndicators", {
      channelId: chA, userId, organizationId: orgA, expiresAt: Date.now() + 5000,
    });
    await ctx.db.insert("typingIndicators", {
      channelId: chB, userId, organizationId: orgB, expiresAt: Date.now() + 5000,
    });
    await ctx.db.insert("channelReadStates", {
      channelId: chA, userId, organizationId: orgA, lastReadAt: Date.now(),
    });
    await ctx.db.insert("channelReadStates", {
      channelId: chB, userId, organizationId: orgB, lastReadAt: Date.now(),
    });
    return { userId, orgA, orgB };
  });

  await t.mutation(internal.clerkSync.deleteMembership, { clerkMembershipId: "mem_a" });
  await t.finishInProgressScheduledFunctions();

  const result = await t.run(async (ctx) => {
    const reactionsInA = await ctx.db
      .query("reactions")
      .withIndex("by_user_and_channel", (q) => q.eq("userId", seeded.userId))
      .collect();
    const typingInA = await ctx.db
      .query("typingIndicators")
      .withIndex("by_user_and_organization", (q) => q.eq("userId", seeded.userId).eq("organizationId", seeded.orgA))
      .collect();
    const readsInA = await ctx.db
      .query("channelReadStates")
      .withIndex("by_user_and_organization", (q) => q.eq("userId", seeded.userId).eq("organizationId", seeded.orgA))
      .collect();
    const allReactions = await ctx.db.query("reactions").collect();
    const allTyping = await ctx.db.query("typingIndicators").collect();
    const allReads = await ctx.db.query("channelReadStates").collect();
    return {
      typingInA: typingInA.length,
      readsInA: readsInA.length,
      reactionsRemaining: allReactions.length,
      typingRemaining: allTyping.length,
      readsRemaining: allReads.length,
      reactionsInA: reactionsInA.length,
    };
  });
  expect(result.typingInA).toBe(0);
  expect(result.readsInA).toBe(0);
  // orgB still has one of each.
  expect(result.typingRemaining).toBe(1);
  expect(result.readsRemaining).toBe(1);
  expect(result.reactionsRemaining).toBe(1);
});

test("deleteOrganization cascades channels, messages, and channelMembers", async () => {
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
    const generalId = await ctx.db.insert("channels", {
      organizationId: orgId,
      slug: "general",
      name: "General",
      createdBy: userId,
      isProtected: true,
    });
    const alphaId = await ctx.db.insert("channels", {
      organizationId: orgId,
      slug: "project-alpha",
      name: "Project Alpha",
      createdBy: userId,
      isProtected: false,
    });
    await ctx.db.insert("channelMembers", {
      userId,
      channelId: generalId,
      organizationId: orgId,
    });
    await ctx.db.insert("channelMembers", {
      userId,
      channelId: alphaId,
      organizationId: orgId,
    });
    await ctx.db.insert("messages", {
      channelId: generalId,
      userId,
      text: "hello",
    });
    await ctx.db.insert("messages", {
      channelId: alphaId,
      userId,
      text: "alpha",
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
  expect(
    await t.run(async (ctx) => await ctx.db.query("channels").collect()),
  ).toHaveLength(0);
  expect(
    await t.run(async (ctx) => await ctx.db.query("channelMembers").collect()),
  ).toHaveLength(0);
  expect(
    await t.run(async (ctx) => await ctx.db.query("messages").collect()),
  ).toHaveLength(0);
});
