# Messaging Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship public channels, plain-text messaging, real-time delivery, and paginated history on top of Foundation, following [docs/superpowers/specs/2026-04-22-messaging-core-design.md](../specs/2026-04-22-messaging-core-design.md).

**Architecture:** Three new Convex tables (`channels`, `channelMembers`, `messages`) with indexed queries; authorization via new `assertChannelMember` helper on top of Foundation's `assertMember`; Foundation's Clerk webhook handlers extended (additive) to auto-provision `#general` and cascade channel data on org/membership lifecycle events; Next.js two-column layout with reactive real-time via Convex `usePaginatedQuery`.

**Tech Stack:** Next.js 16 App Router, React 19, `@clerk/nextjs` 6.39.1, Convex 1.35.1, `convex-test`, `vitest` (edge-runtime env), Tailwind 4. No new dependencies.

---

## Pre-flight check

- [ ] Foundation PR #1 is merged to `master` → rebase this branch onto master: `git fetch origin && git rebase origin/master`. If PR #1 is still open, keep the base branch as `foundation` and rebase later.
- [ ] `cd slack-b2b-app && npm run test` passes (20/20 from Foundation).
- [ ] `npm run build` clean.

---

## File structure after Messaging core

```
slack-b2b-app/
├── app/
│   ├── [slug]/
│   │   ├── layout.tsx                      ← modified (two-column shell)
│   │   ├── page.tsx                        ← modified (redirect to /channels/general)
│   │   ├── members/page.tsx                (unchanged)
│   │   └── channels/
│   │       └── [channel]/page.tsx          ← created
│   └── ...                                 (Foundation routes unchanged)
├── components/
│   ├── SyncUser.tsx                        (unchanged)
│   ├── SyncActiveOrg.tsx                   (unchanged)
│   ├── ConvexClientProvider.tsx            (unchanged)
│   └── messaging/
│       ├── WorkspaceSidebar.tsx            ← created
│       ├── ChannelHeader.tsx               ← created
│       ├── MessageList.tsx                 ← created
│       ├── MessageRow.tsx                  ← created
│       ├── MessageComposer.tsx             ← created
│       ├── CreateChannelModal.tsx          ← created
│       └── BrowseChannelsModal.tsx         ← created
└── convex/
    ├── schema.ts                           ← modified (3 new tables)
    ├── auth.ts                             ← modified (+assertChannelMember)
    ├── auth.config.ts                      (unchanged)
    ├── users.ts                            (unchanged)
    ├── workspace.ts                        (unchanged)
    ├── http.ts                             (unchanged)
    ├── clerkSync.ts                        ← modified (3 handlers extended)
    ├── channels.ts                         ← created
    ├── messages.ts                         ← created
    ├── channels.test.ts                    ← created
    ├── messages.test.ts                    ← created
    ├── clerkSync.test.ts                   ← modified (new cases)
    └── workspace.test.ts                   (unchanged)
```

---

## Task 1: Extend Convex schema with `channels`, `channelMembers`, `messages`

**Files:**
- Modify: `slack-b2b-app/convex/schema.ts`

- [ ] **Step 1: Replace `convex/schema.ts`**

Full file contents:

```typescript
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  users: defineTable({
    clerkUserId: v.string(),
    tokenIdentifier: v.string(),
    email: v.string(),
    name: v.optional(v.string()),
    imageUrl: v.optional(v.string()),
  })
    .index("by_clerk_user_id", ["clerkUserId"])
    .index("by_token_identifier", ["tokenIdentifier"]),

  organizations: defineTable({
    clerkOrgId: v.string(),
    slug: v.string(),
    name: v.string(),
    imageUrl: v.optional(v.string()),
  })
    .index("by_clerk_org_id", ["clerkOrgId"])
    .index("by_slug", ["slug"]),

  memberships: defineTable({
    userId: v.id("users"),
    organizationId: v.id("organizations"),
    clerkMembershipId: v.string(),
    role: v.string(),
  })
    .index("by_user", ["userId"])
    .index("by_organization", ["organizationId"])
    .index("by_user_and_organization", ["userId", "organizationId"])
    .index("by_clerk_membership_id", ["clerkMembershipId"]),

  channels: defineTable({
    organizationId: v.id("organizations"),
    slug: v.string(),
    name: v.string(),
    createdBy: v.id("users"),
    isProtected: v.boolean(),
  })
    .index("by_organization", ["organizationId"])
    .index("by_organization_and_slug", ["organizationId", "slug"]),

  channelMembers: defineTable({
    channelId: v.id("channels"),
    userId: v.id("users"),
    organizationId: v.id("organizations"),
  })
    .index("by_channel", ["channelId"])
    .index("by_user_and_channel", ["userId", "channelId"])
    .index("by_user_and_organization", ["userId", "organizationId"]),

  messages: defineTable({
    channelId: v.id("channels"),
    userId: v.id("users"),
    text: v.string(),
    deletedAt: v.optional(v.number()),
  })
    .index("by_channel", ["channelId"]),
});
```

- [ ] **Step 2: Push schema to Convex dev**

Run:
```bash
cd c:/dev/b2bslack/slack-b2b-app
npx convex dev --once
```

Expected: `Convex functions ready!` with no type errors. Output lists the 6 new indexes added (`channels.by_organization`, `channels.by_organization_and_slug`, `channelMembers.by_channel`, `channelMembers.by_user_and_channel`, `channelMembers.by_user_and_organization`, `messages.by_channel`).

- [ ] **Step 3: Run existing tests to confirm nothing broke**

Run:
```bash
npm run test
```

Expected: 20/20 tests still passing (Foundation's tests).

- [ ] **Step 4: Commit**

```bash
git add convex/schema.ts
git commit -m "feat(convex): add channels, channelMembers, messages tables"
```

---

## Task 2: Add `assertChannelMember` helper to `convex/auth.ts`

**Files:**
- Modify: `slack-b2b-app/convex/auth.ts`

- [ ] **Step 1: Append `assertChannelMember` to `convex/auth.ts`**

Open the file and add this export below the existing `assertMember`:

```typescript
/**
 * Throws if the user is not a member of the channel. Also verifies the
 * channel belongs to the given organization (defense-in-depth against
 * cross-workspace data leaks).
 */
export async function assertChannelMember(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
  channelId: Id<"channels">,
): Promise<{ channel: Doc<"channels">; member: Doc<"channelMembers"> }> {
  const channel = await ctx.db.get(channelId);
  if (!channel) throw new Error(`Channel not found: ${channelId}`);

  const member = await ctx.db
    .query("channelMembers")
    .withIndex("by_user_and_channel", (q) =>
      q.eq("userId", userId).eq("channelId", channel._id),
    )
    .unique();
  if (!member) throw new Error(`Not a channel member: ${channel.slug}`);

  return { channel, member };
}
```

- [ ] **Step 2: Push to Convex**

Run:
```bash
npx convex dev --once
```

Expected: `Convex functions ready!`, no type errors.

- [ ] **Step 3: Commit**

```bash
git add convex/auth.ts
git commit -m "feat(convex): add assertChannelMember helper"
```

Tests for `assertChannelMember` land in Task 5 (alongside `channels.create`/`join` tests that exercise it).

---

## Task 3: Extend `upsertMembership` — auto-create `#general` and auto-join

**Files:**
- Modify: `slack-b2b-app/convex/clerkSync.ts`
- Modify: `slack-b2b-app/convex/clerkSync.test.ts`

- [ ] **Step 1: Append the new failing tests to `clerkSync.test.ts`**

Append at the bottom of the file:

```typescript
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
```

- [ ] **Step 2: Run tests to confirm they fail**

Run:
```bash
npm run test -- clerkSync
```

Expected: 2 NEW failures — existing 10 still pass, 2 new ones expect channels but find none.

- [ ] **Step 3: Update `upsertMembership` handler in `convex/clerkSync.ts`**

Find the `upsertMembership` export and replace its `handler` body. The new handler still does the membership insert, then ensures `#general` exists + adds the user to it.

Replace the entire `upsertMembership` export:

```typescript
export const upsertMembership = internalMutation({
  args: { data: v.any(), attempts: v.number() },
  handler: async (ctx, { data, attempts }) => {
    const m = data as ClerkMembershipData;
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerk_user_id", (q) =>
        q.eq("clerkUserId", m.public_user_data.user_id),
      )
      .unique();
    const org = await ctx.db
      .query("organizations")
      .withIndex("by_clerk_org_id", (q) => q.eq("clerkOrgId", m.organization.id))
      .unique();

    if (!user || !org) {
      if (attempts >= MAX_MEMBERSHIP_RETRIES) {
        console.error(
          `upsertMembership giving up on ${m.id} after ${attempts} attempts: user=${!!user} org=${!!org}`,
        );
        return;
      }
      await ctx.scheduler.runAfter(
        5000,
        internal.clerkSync.upsertMembership,
        { data, attempts: attempts + 1 },
      );
      return;
    }

    // 1. Workspace membership row (existing behavior).
    const existing = await ctx.db
      .query("memberships")
      .withIndex("by_clerk_membership_id", (q) =>
        q.eq("clerkMembershipId", m.id),
      )
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, { role: m.role });
    } else {
      await ctx.db.insert("memberships", {
        userId: user._id,
        organizationId: org._id,
        clerkMembershipId: m.id,
        role: m.role,
      });
    }

    // 2. Ensure #general exists (idempotent).
    let general = await ctx.db
      .query("channels")
      .withIndex("by_organization_and_slug", (q) =>
        q.eq("organizationId", org._id).eq("slug", "general"),
      )
      .unique();
    if (!general) {
      const generalId = await ctx.db.insert("channels", {
        organizationId: org._id,
        slug: "general",
        name: "General",
        createdBy: user._id,
        isProtected: true,
      });
      general = await ctx.db.get(generalId);
    }

    // 3. Add this user to every protected channel in the workspace.
    const protectedChannels = await ctx.db
      .query("channels")
      .withIndex("by_organization", (q) => q.eq("organizationId", org._id))
      .collect();
    for (const ch of protectedChannels) {
      if (!ch.isProtected) continue;
      const already = await ctx.db
        .query("channelMembers")
        .withIndex("by_user_and_channel", (q) =>
          q.eq("userId", user._id).eq("channelId", ch._id),
        )
        .unique();
      if (!already) {
        await ctx.db.insert("channelMembers", {
          userId: user._id,
          channelId: ch._id,
          organizationId: org._id,
        });
      }
    }
  },
});
```

- [ ] **Step 4: Run tests to verify pass**

Run:
```bash
npm run test -- clerkSync
```

Expected: 12 passing tests in `clerkSync.test.ts` (10 original + 2 new).

- [ ] **Step 5: Commit**

```bash
git add convex/clerkSync.ts convex/clerkSync.test.ts
git commit -m "feat(convex): upsertMembership auto-creates #general + auto-joins new members"
```

---

## Task 4: Extend `deleteMembership` — cascade `channelMembers`

**Files:**
- Modify: `slack-b2b-app/convex/clerkSync.ts`
- Modify: `slack-b2b-app/convex/clerkSync.test.ts`

- [ ] **Step 1: Append failing test to `clerkSync.test.ts`**

```typescript
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
```

- [ ] **Step 2: Run tests to confirm failure**

Run:
```bash
npm run test -- clerkSync
```

Expected: 1 new failure (still 2 channelMembers rows after delete — the old handler doesn't cascade them).

- [ ] **Step 3: Update `deleteMembership` handler in `convex/clerkSync.ts`**

Replace the entire `deleteMembership` export:

```typescript
export const deleteMembership = internalMutation({
  args: { clerkMembershipId: v.string() },
  handler: async (ctx, { clerkMembershipId }) => {
    const membership = await ctx.db
      .query("memberships")
      .withIndex("by_clerk_membership_id", (q) =>
        q.eq("clerkMembershipId", clerkMembershipId),
      )
      .unique();
    if (!membership) return;

    // Remove this user from every channel in this workspace.
    const channelMemberships = await ctx.db
      .query("channelMembers")
      .withIndex("by_user_and_organization", (q) =>
        q
          .eq("userId", membership.userId)
          .eq("organizationId", membership.organizationId),
      )
      .take(256);
    for (const cm of channelMemberships) await ctx.db.delete(cm._id);

    await ctx.db.delete(membership._id);
  },
});
```

- [ ] **Step 4: Run tests to verify pass**

```bash
npm run test -- clerkSync
```

Expected: 13 passing tests (12 from before + 1 new).

- [ ] **Step 5: Commit**

```bash
git add convex/clerkSync.ts convex/clerkSync.test.ts
git commit -m "feat(convex): deleteMembership cascades channelMembers within workspace"
```

---

## Task 5: Extend `deleteOrganization` — cascade channels + messages + channelMembers

**Files:**
- Modify: `slack-b2b-app/convex/clerkSync.ts`
- Modify: `slack-b2b-app/convex/clerkSync.test.ts`

- [ ] **Step 1: Append failing test to `clerkSync.test.ts`**

```typescript
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
```

- [ ] **Step 2: Run tests to confirm failure**

```bash
npm run test -- clerkSync
```

Expected: 1 new failure — channels/channelMembers/messages remain after delete.

- [ ] **Step 3: Update `deleteOrganization` handler in `convex/clerkSync.ts`**

Replace the entire `deleteOrganization` export:

```typescript
export const deleteOrganization = internalMutation({
  args: { clerkOrgId: v.string() },
  handler: async (ctx, { clerkOrgId }) => {
    const org = await ctx.db
      .query("organizations")
      .withIndex("by_clerk_org_id", (q) => q.eq("clerkOrgId", clerkOrgId))
      .unique();
    if (!org) return;

    // 1. Channels + their cascades (messages, channelMembers).
    const channels = await ctx.db
      .query("channels")
      .withIndex("by_organization", (q) => q.eq("organizationId", org._id))
      .take(256);
    for (const ch of channels) {
      const messages = await ctx.db
        .query("messages")
        .withIndex("by_channel", (q) => q.eq("channelId", ch._id))
        .take(256);
      for (const msg of messages) await ctx.db.delete(msg._id);

      const cmembers = await ctx.db
        .query("channelMembers")
        .withIndex("by_channel", (q) => q.eq("channelId", ch._id))
        .take(256);
      for (const cm of cmembers) await ctx.db.delete(cm._id);

      await ctx.db.delete(ch._id);
    }

    // 2. Workspace memberships (Foundation cascade behavior).
    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_organization", (q) => q.eq("organizationId", org._id))
      .take(256);
    for (const mem of memberships) await ctx.db.delete(mem._id);

    // 3. The org row.
    await ctx.db.delete(org._id);
  },
});
```

- [ ] **Step 4: Run tests to verify pass**

```bash
npm run test -- clerkSync
```

Expected: 14 passing tests.

- [ ] **Step 5: Commit**

```bash
git add convex/clerkSync.ts convex/clerkSync.test.ts
git commit -m "feat(convex): deleteOrganization cascades channels, messages, channelMembers"
```

---

## Task 6: `channels.create` mutation + tests

**Files:**
- Create: `slack-b2b-app/convex/channels.ts`
- Create: `slack-b2b-app/convex/channels.test.ts`

- [ ] **Step 1: Create `convex/channels.test.ts` with the failing tests**

Full file contents:

```typescript
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
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npm run test -- channels
```

Expected: FAIL — `api.channels.create` not defined.

- [ ] **Step 3: Create `convex/channels.ts`**

Full file contents:

```typescript
import { v } from "convex/values";
import { mutation } from "./_generated/server";
import { assertMember, ensureUser } from "./auth";

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;

export const create = mutation({
  args: {
    workspaceSlug: v.string(),
    name: v.string(),
    slug: v.string(),
  },
  handler: async (ctx, args) => {
    if (!SLUG_RE.test(args.slug)) {
      throw new Error(
        "Invalid slug: must be lowercase letters, digits, hyphens, start with alphanumeric, max 80 chars.",
      );
    }
    const trimmedName = args.name.trim();
    if (!trimmedName || trimmedName.length > 80) {
      throw new Error("Channel name must be 1–80 characters.");
    }

    const user = await ensureUser(ctx);
    const { org } = await assertMember(ctx, user._id, args.workspaceSlug);

    const collision = await ctx.db
      .query("channels")
      .withIndex("by_organization_and_slug", (q) =>
        q.eq("organizationId", org._id).eq("slug", args.slug),
      )
      .unique();
    if (collision) throw new Error(`Channel slug "${args.slug}" is taken.`);

    const channelId = await ctx.db.insert("channels", {
      organizationId: org._id,
      slug: args.slug,
      name: trimmedName,
      createdBy: user._id,
      isProtected: false,
    });
    await ctx.db.insert("channelMembers", {
      channelId,
      userId: user._id,
      organizationId: org._id,
    });
    return channelId;
  },
});
```

- [ ] **Step 4: Push to Convex**

```bash
npx convex dev --once
```

Expected: clean push.

- [ ] **Step 5: Run tests to verify pass**

```bash
npm run test -- channels
```

Expected: 4 passing tests.

- [ ] **Step 6: Commit**

```bash
git add convex/channels.ts convex/channels.test.ts
git commit -m "feat(convex): add channels.create mutation"
```

---

## Task 7: `channels.join` + `channels.leave` + tests

**Files:**
- Modify: `slack-b2b-app/convex/channels.ts`
- Modify: `slack-b2b-app/convex/channels.test.ts`

- [ ] **Step 1: Append failing tests to `channels.test.ts`**

```typescript
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
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npm run test -- channels
```

Expected: 4 new failures (`api.channels.join` / `api.channels.leave` not defined).

- [ ] **Step 3: Append to `convex/channels.ts`**

Append below the `create` export:

```typescript
export const join = mutation({
  args: { channelId: v.id("channels") },
  handler: async (ctx, args) => {
    const user = await ensureUser(ctx);
    const channel = await ctx.db.get(args.channelId);
    if (!channel) throw new Error(`Channel not found: ${args.channelId}`);

    const org = await ctx.db.get(channel.organizationId);
    if (!org) throw new Error("Channel belongs to an unknown workspace.");
    await assertMember(ctx, user._id, org.slug);

    const existing = await ctx.db
      .query("channelMembers")
      .withIndex("by_user_and_channel", (q) =>
        q.eq("userId", user._id).eq("channelId", channel._id),
      )
      .unique();
    if (existing) return existing._id;

    return await ctx.db.insert("channelMembers", {
      channelId: channel._id,
      userId: user._id,
      organizationId: channel.organizationId,
    });
  },
});

export const leave = mutation({
  args: { channelId: v.id("channels") },
  handler: async (ctx, args) => {
    const user = await ensureUser(ctx);
    const channel = await ctx.db.get(args.channelId);
    if (!channel) throw new Error(`Channel not found: ${args.channelId}`);
    if (channel.isProtected) {
      throw new Error(`Cannot leave the ${channel.slug} channel.`);
    }

    const membership = await ctx.db
      .query("channelMembers")
      .withIndex("by_user_and_channel", (q) =>
        q.eq("userId", user._id).eq("channelId", channel._id),
      )
      .unique();
    if (membership) await ctx.db.delete(membership._id);
  },
});
```

- [ ] **Step 4: Push + test**

```bash
npx convex dev --once
npm run test -- channels
```

Expected: 8 passing tests in `channels.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add convex/channels.ts convex/channels.test.ts
git commit -m "feat(convex): add channels.join + channels.leave"
```

---

## Task 8: `channels.deleteChannel` + tests

**Files:**
- Modify: `slack-b2b-app/convex/channels.ts`
- Modify: `slack-b2b-app/convex/channels.test.ts`

- [ ] **Step 1: Append failing tests to `channels.test.ts`**

```typescript
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
```

- [ ] **Step 2: Run tests to confirm failure**

```bash
npm run test -- channels
```

Expected: 3 new failures.

- [ ] **Step 3: Append `deleteChannel` to `convex/channels.ts`**

Append below `leave`:

```typescript
export const deleteChannel = mutation({
  args: { channelId: v.id("channels") },
  handler: async (ctx, args) => {
    const user = await ensureUser(ctx);
    const channel = await ctx.db.get(args.channelId);
    if (!channel) throw new Error(`Channel not found: ${args.channelId}`);
    if (channel.isProtected) {
      throw new Error(`Cannot delete the protected ${channel.slug} channel.`);
    }

    const org = await ctx.db.get(channel.organizationId);
    if (!org) throw new Error("Channel belongs to an unknown workspace.");
    const { membership } = await assertMember(ctx, user._id, org.slug);
    if (membership.role !== "org:admin") {
      throw new Error("Only workspace admins can delete channels.");
    }

    // Cascade messages (batched).
    const messages = await ctx.db
      .query("messages")
      .withIndex("by_channel", (q) => q.eq("channelId", channel._id))
      .take(256);
    for (const msg of messages) await ctx.db.delete(msg._id);

    // Cascade channelMembers (batched).
    const cmembers = await ctx.db
      .query("channelMembers")
      .withIndex("by_channel", (q) => q.eq("channelId", channel._id))
      .take(256);
    for (const cm of cmembers) await ctx.db.delete(cm._id);

    await ctx.db.delete(channel._id);
  },
});
```

- [ ] **Step 4: Push + test**

```bash
npx convex dev --once
npm run test -- channels
```

Expected: 11 passing tests in `channels.test.ts` (4 create + 4 join/leave + 3 delete).

- [ ] **Step 5: Commit**

```bash
git add convex/channels.ts convex/channels.test.ts
git commit -m "feat(convex): add channels.deleteChannel (admin + cascade)"
```

---

## Task 9: Channels queries — `listMine`, `getBySlug`, `listBrowsable`

**Files:**
- Modify: `slack-b2b-app/convex/channels.ts`
- Modify: `slack-b2b-app/convex/channels.test.ts`

- [ ] **Step 1: Append failing tests**

```typescript
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
```

- [ ] **Step 2: Run tests to confirm failure**

```bash
npm run test -- channels
```

Expected: 4 new failures.

- [ ] **Step 3: Append queries to `convex/channels.ts`**

At the top of the file, add `query` to the imports from `./_generated/server`:

```typescript
import { mutation, query } from "./_generated/server";
import { assertChannelMember, assertMember, ensureUser, getAuthedUser } from "./auth";
```

Append at the bottom of the file:

```typescript
export const listMine = query({
  args: { workspaceSlug: v.string() },
  handler: async (ctx, args) => {
    const user = await getAuthedUser(ctx);
    if (!user) return [];
    const { org } = await assertMember(ctx, user._id, args.workspaceSlug);

    const memberships = await ctx.db
      .query("channelMembers")
      .withIndex("by_user_and_organization", (q) =>
        q.eq("userId", user._id).eq("organizationId", org._id),
      )
      .take(200);

    const channels = await Promise.all(
      memberships.map((m) => ctx.db.get(m.channelId)),
    );
    return channels
      .filter((c): c is NonNullable<typeof c> => c !== null)
      .sort((a, b) => a.name.localeCompare(b.name));
  },
});

export const getBySlug = query({
  args: { workspaceSlug: v.string(), channelSlug: v.string() },
  handler: async (ctx, args) => {
    const user = await getAuthedUser(ctx);
    if (!user) throw new Error("Not authenticated");
    const { org } = await assertMember(ctx, user._id, args.workspaceSlug);

    const channel = await ctx.db
      .query("channels")
      .withIndex("by_organization_and_slug", (q) =>
        q.eq("organizationId", org._id).eq("slug", args.channelSlug),
      )
      .unique();
    if (!channel) throw new Error(`Channel not found: ${args.channelSlug}`);

    const { member } = await assertChannelMember(ctx, user._id, channel._id);

    // Member count (small workspaces — bounded .take(1000) is fine for core).
    const memberCount = (
      await ctx.db
        .query("channelMembers")
        .withIndex("by_channel", (q) => q.eq("channelId", channel._id))
        .take(1000)
    ).length;

    return { channel, membership: member, memberCount };
  },
});

export const listBrowsable = query({
  args: { workspaceSlug: v.string() },
  handler: async (ctx, args) => {
    const user = await getAuthedUser(ctx);
    if (!user) return [];
    const { org } = await assertMember(ctx, user._id, args.workspaceSlug);

    const allChannels = await ctx.db
      .query("channels")
      .withIndex("by_organization", (q) => q.eq("organizationId", org._id))
      .take(200);

    const myMemberships = await ctx.db
      .query("channelMembers")
      .withIndex("by_user_and_organization", (q) =>
        q.eq("userId", user._id).eq("organizationId", org._id),
      )
      .take(200);
    const joinedIds = new Set(myMemberships.map((m) => m.channelId));

    return allChannels
      .filter((c) => !joinedIds.has(c._id))
      .sort((a, b) => a.name.localeCompare(b.name));
  },
});
```

- [ ] **Step 4: Push + test**

```bash
npx convex dev --once
npm run test -- channels
```

Expected: 15 passing tests in `channels.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add convex/channels.ts convex/channels.test.ts
git commit -m "feat(convex): add channels.listMine / getBySlug / listBrowsable queries"
```

---

## Task 10: `messages.send` mutation + tests

**Files:**
- Create: `slack-b2b-app/convex/messages.ts`
- Create: `slack-b2b-app/convex/messages.test.ts`

- [ ] **Step 1: Create `convex/messages.test.ts`**

```typescript
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
```

- [ ] **Step 2: Run to confirm failure**

```bash
npm run test -- messages
```

Expected: FAIL — `api.messages.send` not defined.

- [ ] **Step 3: Create `convex/messages.ts`**

```typescript
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { paginationOptsValidator } from "convex/server";
import { assertChannelMember, ensureUser } from "./auth";

const MAX_TEXT_LEN = 4000;

export const send = mutation({
  args: { channelId: v.id("channels"), text: v.string() },
  handler: async (ctx, args) => {
    const trimmed = args.text.trim();
    if (!trimmed) throw new Error("Message text cannot be empty.");
    if (trimmed.length > MAX_TEXT_LEN) {
      throw new Error(`Message exceeds maximum length of ${MAX_TEXT_LEN} characters.`);
    }

    const user = await ensureUser(ctx);
    await assertChannelMember(ctx, user._id, args.channelId);

    return await ctx.db.insert("messages", {
      channelId: args.channelId,
      userId: user._id,
      text: trimmed,
    });
  },
});
```

- [ ] **Step 4: Push + test**

```bash
npx convex dev --once
npm run test -- messages
```

Expected: 5 passing tests.

- [ ] **Step 5: Commit**

```bash
git add convex/messages.ts convex/messages.test.ts
git commit -m "feat(convex): add messages.send mutation"
```

---

## Task 11: `messages.list` paginated query + tests

**Files:**
- Modify: `slack-b2b-app/convex/messages.ts`
- Modify: `slack-b2b-app/convex/messages.test.ts`

- [ ] **Step 1: Append failing tests**

```typescript
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
```

- [ ] **Step 2: Run tests to confirm failure**

```bash
npm run test -- messages
```

Expected: 3 new failures (`api.messages.list` not defined).

- [ ] **Step 3: Append `list` to `convex/messages.ts`**

```typescript
export const list = query({
  args: {
    channelId: v.id("channels"),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");
    const user = await ctx.db
      .query("users")
      .withIndex("by_token_identifier", (q) =>
        q.eq("tokenIdentifier", identity.tokenIdentifier),
      )
      .unique();
    if (!user) throw new Error("Not authenticated");
    await assertChannelMember(ctx, user._id, args.channelId);

    const result = await ctx.db
      .query("messages")
      .withIndex("by_channel", (q) => q.eq("channelId", args.channelId))
      .order("desc")
      .paginate(args.paginationOpts);

    // Join author info server-side so the client doesn't N+1.
    const authorIds = [...new Set(result.page.map((m) => m.userId))];
    const authors = await Promise.all(authorIds.map((id) => ctx.db.get(id)));
    const authorById = new Map(
      authors
        .filter((a): a is NonNullable<typeof a> => a !== null)
        .map((a) => [a._id, a]),
    );

    return {
      ...result,
      page: result.page.map((message) => {
        const a = authorById.get(message.userId);
        return {
          message,
          author: a
            ? { _id: a._id, name: a.name ?? null, imageUrl: a.imageUrl ?? null }
            : { _id: message.userId, name: null, imageUrl: null },
        };
      }),
    };
  },
});
```

- [ ] **Step 4: Push + test**

```bash
npx convex dev --once
npm run test -- messages
```

Expected: 8 passing tests.

- [ ] **Step 5: Commit**

```bash
git add convex/messages.ts convex/messages.test.ts
git commit -m "feat(convex): add messages.list paginated query with server-side author join"
```

---

## Task 12: `messages.deleteMessage` + tests

**Files:**
- Modify: `slack-b2b-app/convex/messages.ts`
- Modify: `slack-b2b-app/convex/messages.test.ts`

- [ ] **Step 1: Append failing tests**

```typescript
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
```

- [ ] **Step 2: Run tests to confirm failure**

```bash
npm run test -- messages
```

Expected: 2 new failures.

- [ ] **Step 3: Append `deleteMessage` to `convex/messages.ts`**

```typescript
export const deleteMessage = mutation({
  args: { messageId: v.id("messages") },
  handler: async (ctx, args) => {
    const user = await ensureUser(ctx);
    const message = await ctx.db.get(args.messageId);
    if (!message) throw new Error(`Message not found: ${args.messageId}`);
    if (message.userId !== user._id) {
      throw new Error("Not authorized: only the author can delete a message.");
    }
    await ctx.db.patch(message._id, { deletedAt: Date.now() });
  },
});
```

- [ ] **Step 4: Push + test**

```bash
npx convex dev --once
npm run test
```

Expected: all tests pass (Foundation's 20 + channels 15 + messages 10 + clerkSync 14 = 59 total).

- [ ] **Step 5: Commit**

```bash
git add convex/messages.ts convex/messages.test.ts
git commit -m "feat(convex): add messages.deleteMessage (soft delete by author)"
```

---

## Task 13: Two-column layout shell + `/[slug]` redirect

**Files:**
- Modify: `slack-b2b-app/app/[slug]/layout.tsx`
- Modify: `slack-b2b-app/app/[slug]/page.tsx`

- [ ] **Step 1: Replace `app/[slug]/layout.tsx`**

```tsx
import { SyncActiveOrg } from "@/components/SyncActiveOrg";
import { WorkspaceSidebar } from "@/components/messaging/WorkspaceSidebar";

export default async function SlugLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return (
    <>
      <SyncActiveOrg slug={slug} />
      <div className="flex flex-1 min-h-0">
        <WorkspaceSidebar slug={slug} />
        <div className="flex flex-col flex-1 min-w-0">{children}</div>
      </div>
    </>
  );
}
```

- [ ] **Step 2: Replace `app/[slug]/page.tsx` — redirect to `/general`**

```tsx
import { redirect } from "next/navigation";

export default async function SlugIndex({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  redirect(`/${slug}/channels/general`);
}
```

- [ ] **Step 3: Create a minimal placeholder `components/messaging/WorkspaceSidebar.tsx`** so the build doesn't break before Task 14 fleshes it out:

```tsx
"use client";

export function WorkspaceSidebar({ slug }: { slug: string }) {
  return (
    <aside className="w-64 flex-shrink-0 border-r bg-zinc-100 p-4 text-sm">
      <div className="font-semibold">{slug}</div>
      <div className="mt-4 text-zinc-500">Channels (coming in Task 14)</div>
    </aside>
  );
}
```

- [ ] **Step 4: Verify the build**

```bash
rm -rf .next
npm run build
```

Expected: build passes. `/` , `/[slug]` (redirect), `/[slug]/members` all compile.

- [ ] **Step 5: Commit**

```bash
git add app/[slug]/layout.tsx app/[slug]/page.tsx components/messaging/WorkspaceSidebar.tsx
git commit -m "feat: two-column /[slug] layout + redirect to #general"
```

---

## Task 14: `<WorkspaceSidebar>` — channel list with active highlighting

**Files:**
- Modify: `slack-b2b-app/components/messaging/WorkspaceSidebar.tsx`

- [ ] **Step 1: Replace the placeholder with the full component**

```tsx
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { useQuery } from "convex/react";
import { OrganizationSwitcher, UserButton } from "@clerk/nextjs";
import { api } from "@/convex/_generated/api";
import { CreateChannelModal } from "@/components/messaging/CreateChannelModal";
import { BrowseChannelsModal } from "@/components/messaging/BrowseChannelsModal";

export function WorkspaceSidebar({ slug }: { slug: string }) {
  const channels = useQuery(api.channels.listMine, { workspaceSlug: slug });
  const pathname = usePathname();
  const [createOpen, setCreateOpen] = useState(false);
  const [browseOpen, setBrowseOpen] = useState(false);

  return (
    <aside className="flex flex-col w-64 flex-shrink-0 border-r bg-zinc-100 dark:bg-zinc-900">
      <div className="p-3 border-b">
        <OrganizationSwitcher
          afterSelectOrganizationUrl="/:slug"
          afterCreateOrganizationUrl="/:slug"
          hidePersonal
        />
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
            Channels
          </span>
          <button
            className="w-5 h-5 rounded hover:bg-zinc-200 dark:hover:bg-zinc-800 text-zinc-500"
            onClick={() => setCreateOpen(true)}
            title="Create channel"
            aria-label="Create channel"
          >
            +
          </button>
        </div>

        {channels === undefined ? (
          <div className="text-xs text-zinc-400">Loading…</div>
        ) : channels.length === 0 ? (
          <div className="text-xs text-zinc-400">No channels yet.</div>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {channels.map((ch) => {
              const href = `/${slug}/channels/${ch.slug}`;
              const isActive = pathname === href;
              return (
                <li key={ch._id}>
                  <Link
                    href={href}
                    className={`block px-2 py-1 rounded text-sm truncate ${
                      isActive
                        ? "bg-zinc-200 dark:bg-zinc-800 font-medium"
                        : "hover:bg-zinc-200 dark:hover:bg-zinc-800"
                    }`}
                  >
                    # {ch.slug}
                  </Link>
                </li>
              );
            })}
          </ul>
        )}

        <button
          className="mt-3 text-xs text-zinc-500 hover:underline"
          onClick={() => setBrowseOpen(true)}
        >
          Browse channels…
        </button>
      </div>

      <div className="p-3 border-t flex items-center justify-between">
        <UserButton />
        <Link href={`/${slug}/members`} className="text-xs underline text-zinc-500">
          Members
        </Link>
      </div>

      <CreateChannelModal
        open={createOpen}
        workspaceSlug={slug}
        onClose={() => setCreateOpen(false)}
      />
      <BrowseChannelsModal
        open={browseOpen}
        workspaceSlug={slug}
        onClose={() => setBrowseOpen(false)}
      />
    </aside>
  );
}
```

(The two modals don't exist yet — Tasks 18 and 19 create them. Build will fail until then. That's fine for now; we'll build them before we come back to test this component end-to-end in Task 21.)

- [ ] **Step 2: Skip commit for now**

Commit is deferred to Task 19 once all imports resolve. This allows us to keep working in small, TDD-friendly files.

---

## Task 15: Channel page skeleton + `<ChannelHeader>` + error boundary for deleted-channel case

**Files:**
- Create: `slack-b2b-app/app/[slug]/channels/[channel]/page.tsx`
- Create: `slack-b2b-app/components/messaging/ChannelHeader.tsx`
- Create: `slack-b2b-app/components/messaging/ChannelErrorBoundary.tsx`

- [ ] **Step 1: Create `components/messaging/ChannelErrorBoundary.tsx`**

When the channel someone is currently viewing gets deleted by an admin, `useQuery(api.channels.getBySlug)` throws. Without an error boundary that's an unhandled error in React. This component catches it and redirects to `/#general`.

```tsx
"use client";

import { Component, ReactNode } from "react";

type Props = {
  children: ReactNode;
  onError: () => void;
};
type State = { hasError: boolean };

export class ChannelErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch() {
    // Fire once; the parent page component's useEffect will handle navigation.
    this.props.onError();
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex-1 flex items-center justify-center text-zinc-400 text-sm">
          Redirecting…
        </div>
      );
    }
    return this.props.children;
  }
}
```

- [ ] **Step 2: Create `app/[slug]/channels/[channel]/page.tsx`**

```tsx
"use client";

import { use, useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { ChannelHeader } from "@/components/messaging/ChannelHeader";
import { ChannelErrorBoundary } from "@/components/messaging/ChannelErrorBoundary";
import { MessageList } from "@/components/messaging/MessageList";
import { MessageComposer } from "@/components/messaging/MessageComposer";

export default function ChannelPage({
  params,
}: {
  params: Promise<{ slug: string; channel: string }>;
}) {
  const { slug, channel } = use(params);
  const router = useRouter();
  const [errored, setErrored] = useState(false);

  useEffect(() => {
    if (errored) router.replace(`/${slug}/channels/general`);
  }, [errored, slug, router]);

  if (errored) {
    return (
      <div className="flex-1 flex items-center justify-center text-zinc-400 text-sm">
        Redirecting…
      </div>
    );
  }

  return (
    <ChannelErrorBoundary onError={() => setErrored(true)}>
      <ChannelContent slug={slug} channel={channel} />
    </ChannelErrorBoundary>
  );
}

function ChannelContent({
  slug,
  channel,
}: {
  slug: string;
  channel: string;
}) {
  const router = useRouter();
  const data = useQuery(api.channels.getBySlug, {
    workspaceSlug: slug,
    channelSlug: channel,
  });
  const deleteChannel = useMutation(api.channels.deleteChannel);

  if (data === undefined) {
    return (
      <div className="flex-1 flex items-center justify-center text-zinc-400">
        Loading…
      </div>
    );
  }

  const isAdmin = data.membership.role === "org:admin";

  const onDeleteChannel = async () => {
    if (!confirm(`Delete #${data.channel.slug}?`)) return;
    await deleteChannel({ channelId: data.channel._id });
    router.push(`/${slug}/channels/general`);
  };

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <ChannelHeader
        name={data.channel.name}
        slug={data.channel.slug}
        memberCount={data.memberCount}
        isProtected={data.channel.isProtected}
        isAdmin={isAdmin}
        onDelete={onDeleteChannel}
      />
      <MessageList channelId={data.channel._id} />
      <MessageComposer channelId={data.channel._id} />
    </div>
  );
}
```

- [ ] **Step 2: Create `components/messaging/ChannelHeader.tsx`**

```tsx
"use client";

import { useState } from "react";
import type { Id } from "@/convex/_generated/dataModel";

export function ChannelHeader({
  name,
  slug,
  memberCount,
  isProtected,
  isAdmin,
  onDelete,
}: {
  name: string;
  slug: string;
  memberCount: number;
  isProtected: boolean;
  isAdmin: boolean;
  onDelete: () => Promise<void>;
}) {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <header className="flex items-center justify-between px-4 py-2 border-b bg-white dark:bg-zinc-950">
      <div>
        <h1 className="font-semibold">
          <span className="text-zinc-400">#</span> {name}
        </h1>
        <div className="text-xs text-zinc-500">
          {memberCount} member{memberCount === 1 ? "" : "s"}
        </div>
      </div>
      {isAdmin && !isProtected && (
        <div className="relative">
          <button
            className="w-8 h-8 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800"
            onClick={() => setMenuOpen((v) => !v)}
            aria-label="Channel menu"
          >
            ⋯
          </button>
          {menuOpen && (
            <div className="absolute right-0 mt-1 bg-white dark:bg-zinc-950 border rounded shadow-md py-1 min-w-[160px] z-10">
              <button
                className="w-full text-left px-3 py-1 text-sm text-red-600 hover:bg-red-50 dark:hover:bg-red-900/30"
                onClick={() => {
                  setMenuOpen(false);
                  void onDelete();
                }}
              >
                Delete channel
              </button>
            </div>
          )}
        </div>
      )}
    </header>
  );
}
```

- [ ] **Step 3: Skip commit for now**

The page imports `<MessageList>` and `<MessageComposer>` which don't exist yet. Defer commit until Task 17 + 18 are in.

---

## Task 16: `<MessageRow>`

**Files:**
- Create: `slack-b2b-app/components/messaging/MessageRow.tsx`

- [ ] **Step 1: Create the file**

```tsx
"use client";

import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";

function formatTime(creationTime: number): string {
  const d = new Date(creationTime);
  const hh = d.getHours().toString().padStart(2, "0");
  const mm = d.getMinutes().toString().padStart(2, "0");
  return `${hh}:${mm}`;
}

export function MessageRow({
  message,
  author,
  isOwn,
}: {
  message: Doc<"messages">;
  author: { _id: Id<"users">; name: string | null; imageUrl: string | null };
  isOwn: boolean;
}) {
  const deleteMessage = useMutation(api.messages.deleteMessage);
  const tombstoned = !!message.deletedAt;

  return (
    <div className="group flex gap-3 px-4 py-1 hover:bg-zinc-50 dark:hover:bg-zinc-900/30">
      <div className="w-9 h-9 rounded bg-zinc-300 dark:bg-zinc-700 flex-shrink-0 overflow-hidden">
        {author.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={author.imageUrl} alt="" className="w-full h-full object-cover" />
        ) : null}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2">
          <span className="font-semibold text-sm">
            {author.name ?? "Deleted user"}
          </span>
          <span className="text-xs text-zinc-500">
            {formatTime(message._creationTime)}
          </span>
        </div>
        <div className="text-sm whitespace-pre-wrap break-words">
          {tombstoned ? (
            <span className="italic text-zinc-400">
              This message was deleted
            </span>
          ) : (
            message.text
          )}
        </div>
      </div>
      {isOwn && !tombstoned && (
        <button
          className="opacity-0 group-hover:opacity-100 text-xs text-red-500 hover:underline self-start"
          onClick={() => {
            if (confirm("Delete this message?")) {
              void deleteMessage({ messageId: message._id });
            }
          }}
        >
          Delete
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Skip commit for now**

---

## Task 17: `<MessageList>` with pagination + scroll behavior

**Files:**
- Create: `slack-b2b-app/components/messaging/MessageList.tsx`

- [ ] **Step 1: Create the file**

```tsx
"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { MessageRow } from "@/components/messaging/MessageRow";

const PAGE_SIZE = 30;
const NEAR_TOP_PX = 200;

export function MessageList({ channelId }: { channelId: Id<"channels"> }) {
  const me = useQuery(api.workspace.whoami, {});
  const { results, status, loadMore } = usePaginatedQuery(
    api.messages.list,
    { channelId },
    { initialNumItems: PAGE_SIZE },
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  const prevScrollHeightRef = useRef<number | null>(null);
  const [atBottom, setAtBottom] = useState(true);

  // Reverse for display: newest at bottom.
  const displayed = results.slice().reverse();

  // On first messages load, scroll to bottom.
  const firstLoadDone = useRef(false);
  useLayoutEffect(() => {
    if (!scrollRef.current) return;
    if (status === "LoadingFirstPage") return;
    if (!firstLoadDone.current && displayed.length > 0) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      firstLoadDone.current = true;
      return;
    }
    // Restore position after `loadMore` prepends older messages.
    if (prevScrollHeightRef.current !== null) {
      const diff =
        scrollRef.current.scrollHeight - prevScrollHeightRef.current;
      scrollRef.current.scrollTop += diff;
      prevScrollHeightRef.current = null;
      return;
    }
    // New message arrived while at bottom → keep bottom anchored.
    if (atBottom) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [displayed.length, status, atBottom]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;

    const nearBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setAtBottom(nearBottom);

    if (
      el.scrollTop < NEAR_TOP_PX &&
      status === "CanLoadMore"
    ) {
      prevScrollHeightRef.current = el.scrollHeight;
      loadMore(PAGE_SIZE);
    }
  };

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      className="flex-1 overflow-y-auto min-h-0 py-2"
    >
      {status === "LoadingFirstPage" ? (
        <div className="text-center text-zinc-400 text-sm py-8">
          Loading messages…
        </div>
      ) : displayed.length === 0 ? (
        <div className="text-center text-zinc-400 text-sm py-8">
          No messages yet. Say hi!
        </div>
      ) : (
        <>
          {status === "LoadingMore" && (
            <div className="text-center text-zinc-400 text-xs py-1">
              Loading older…
            </div>
          )}
          {displayed.map((row) => (
            <MessageRow
              key={row.message._id}
              message={row.message}
              author={row.author}
              isOwn={!!me && row.author._id === me._id}
            />
          ))}
        </>
      )}
      {!atBottom && (
        <button
          className="fixed bottom-24 right-10 bg-blue-600 text-white text-xs rounded-full px-3 py-1 shadow"
          onClick={() => {
            if (scrollRef.current) {
              scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
            }
          }}
        >
          New messages ↓
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Skip commit for now**

---

## Task 18: `<MessageComposer>`

**Files:**
- Create: `slack-b2b-app/components/messaging/MessageComposer.tsx`

- [ ] **Step 1: Create the file**

```tsx
"use client";

import { useState, KeyboardEvent } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

const MAX = 4000;

export function MessageComposer({
  channelId,
}: {
  channelId: Id<"channels">;
}) {
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const send = useMutation(api.messages.send);

  const disabled = pending || !text.trim() || text.length > MAX;

  const submit = async () => {
    if (disabled) return;
    setPending(true);
    try {
      await send({ channelId, text });
      setText("");
    } finally {
      setPending(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <div className="border-t p-3 bg-white dark:bg-zinc-950">
      <div className="flex gap-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Message #channel"
          rows={2}
          maxLength={MAX + 100}
          className="flex-1 resize-none rounded border px-3 py-2 text-sm dark:bg-zinc-900"
        />
        <button
          disabled={disabled}
          onClick={() => void submit()}
          className="px-4 rounded bg-foreground text-background text-sm font-medium disabled:opacity-50"
        >
          Send
        </button>
      </div>
      {text.length > 3800 && (
        <div className="text-xs text-right mt-1 text-zinc-500">
          {text.length} / {MAX}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Skip commit for now**

---

## Task 19: `<CreateChannelModal>` + `<BrowseChannelsModal>` + commit all UI

**Files:**
- Create: `slack-b2b-app/components/messaging/CreateChannelModal.tsx`
- Create: `slack-b2b-app/components/messaging/BrowseChannelsModal.tsx`

- [ ] **Step 1: Create `CreateChannelModal.tsx`**

```tsx
"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";

function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function CreateChannelModal({
  open,
  workspaceSlug,
  onClose,
}: {
  open: boolean;
  workspaceSlug: string;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const create = useMutation(api.channels.create);
  const router = useRouter();

  const slug = slugify(name);

  if (!open) return null;

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!slug) {
      setError("Channel name must contain alphanumeric characters.");
      return;
    }
    setSubmitting(true);
    try {
      await create({ workspaceSlug, name, slug });
      onClose();
      setName("");
      router.push(`/${workspaceSlug}/channels/${slug}`);
    } catch (err: any) {
      setError(err?.message ?? "Failed to create channel");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-20 bg-black/40 flex items-center justify-center">
      <form
        onSubmit={onSubmit}
        className="bg-white dark:bg-zinc-950 rounded-lg shadow-xl p-6 w-full max-w-md flex flex-col gap-3"
      >
        <h2 className="text-lg font-semibold">Create a channel</h2>
        <label className="flex flex-col gap-1 text-sm">
          <span>Name</span>
          <input
            autoFocus
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="project-alpha"
            maxLength={80}
            className="rounded border px-3 py-2 text-sm dark:bg-zinc-900"
          />
        </label>
        {name && (
          <div className="text-xs text-zinc-500">
            URL: <code>/{workspaceSlug}/channels/{slug || "—"}</code>
          </div>
        )}
        {error && <div className="text-xs text-red-600">{error}</div>}
        <div className="flex justify-end gap-2 mt-2">
          <button
            type="button"
            className="px-3 py-1 rounded text-sm"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting || !slug}
            className="px-3 py-1 rounded bg-foreground text-background text-sm disabled:opacity-50"
          >
            {submitting ? "Creating…" : "Create"}
          </button>
        </div>
      </form>
    </div>
  );
}
```

- [ ] **Step 2: Create `BrowseChannelsModal.tsx`**

```tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";

export function BrowseChannelsModal({
  open,
  workspaceSlug,
  onClose,
}: {
  open: boolean;
  workspaceSlug: string;
  onClose: () => void;
}) {
  const browsable = useQuery(
    api.channels.listBrowsable,
    open ? { workspaceSlug } : "skip",
  );
  const join = useMutation(api.channels.join);
  const router = useRouter();
  const [joiningId, setJoiningId] = useState<string | null>(null);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-20 bg-black/40 flex items-center justify-center">
      <div className="bg-white dark:bg-zinc-950 rounded-lg shadow-xl p-6 w-full max-w-md flex flex-col gap-3 max-h-[80vh]">
        <h2 className="text-lg font-semibold">Browse channels</h2>
        <div className="flex-1 overflow-y-auto">
          {browsable === undefined ? (
            <div className="text-sm text-zinc-400">Loading…</div>
          ) : browsable.length === 0 ? (
            <div className="text-sm text-zinc-400">
              No channels to join — you're in all of them.
            </div>
          ) : (
            <ul className="flex flex-col gap-1">
              {browsable.map((ch) => (
                <li
                  key={ch._id}
                  className="flex items-center justify-between border rounded px-3 py-2"
                >
                  <div>
                    <div className="text-sm font-medium"># {ch.slug}</div>
                    <div className="text-xs text-zinc-500">{ch.name}</div>
                  </div>
                  <button
                    disabled={joiningId === ch._id}
                    onClick={async () => {
                      setJoiningId(ch._id);
                      try {
                        await join({ channelId: ch._id });
                        onClose();
                        router.push(
                          `/${workspaceSlug}/channels/${ch.slug}`,
                        );
                      } finally {
                        setJoiningId(null);
                      }
                    }}
                    className="text-sm px-3 py-1 rounded bg-foreground text-background disabled:opacity-50"
                  >
                    {joiningId === ch._id ? "Joining…" : "Join"}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="flex justify-end">
          <button className="px-3 py-1 rounded text-sm" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Verify full build**

```bash
rm -rf .next
npm run build
```

Expected: build passes; routes registered include `/[slug]/channels/[channel]`.

- [ ] **Step 4: Commit the whole UI layer (Tasks 14–19 at once)**

```bash
git add app/[slug] components/messaging
git commit -m "feat(ui): messaging core UI — sidebar, channel page, list, composer, modals"
```

---

## Task 20: Manual E2E — the 10 acceptance steps

**Files:** none.

- [ ] **Step 1: Delete test workspaces created during Foundation testing**

Open Clerk Dashboard → Organizations. Delete any test workspaces you made during Foundation manual E2E. This ensures the new webhook flow fires end-to-end on fresh data.

(In Convex Dashboard → Data → confirm `channels`, `channelMembers`, `messages` tables are empty afterwards. The `deleteOrganization` cascade you built in Task 5 should have cleaned them.)

- [ ] **Step 2: Start both servers**

```bash
cd c:/dev/b2bslack/slack-b2b-app
npm run dev
```

Wait for both Next.js and Convex backends to boot.

- [ ] **Step 3: Walk through the 10 acceptance steps**

In two browser windows (one normal, one incognito), logged in as two different test accounts:

- [ ] **Alice** signs up, creates workspace "Acme". URL auto-redirects from `/acme` to `/acme/channels/general`. Sidebar shows `# general` highlighted.
- [ ] Alice posts **"hello"** in the composer. It appears immediately at the bottom with her name and current time.
- [ ] **Bob** is invited via Clerk (use the copy-invitation-link trick if email doesn't arrive). Bob signs up in incognito, lands on `/acme/channels/general`, sees Alice's "hello" automatically.
- [ ] Alice clicks `+` in the sidebar, creates channel **"Project Alpha"** (slug auto-becomes `project-alpha`). URL navigates to `/acme/channels/project-alpha`, sidebar shows it highlighted.
- [ ] Bob **does NOT** see `# project-alpha` in his sidebar. He clicks **"Browse channels…"**, sees `# project-alpha`, clicks **Join**.
- [ ] Bob's sidebar updates, URL navigates to `/acme/channels/project-alpha`.
- [ ] Alice posts **35 messages** quickly. Bob scrolls up; older messages load (watch for the "Loading older…" strip at the top). Scroll position preserved when messages prepend.
- [ ] Alice hovers one of her messages, clicks **Delete** (the red button that appears on hover), confirms. Her view shows *"This message was deleted"* in italics. Bob sees the same tombstone within ~1s. Bob has no Delete button on Alice's messages.
- [ ] Alice tries to leave `# general` — there's no Leave option because it's protected. (If you manually call `api.channels.leave` via the Convex dashboard, it throws `Cannot leave the general channel`.)
- [ ] Alice (admin) clicks the channel kebab on `# project-alpha` → **Delete channel** → confirm. Channel disappears from both sidebars. Bob's browser (currently on that channel) redirects to `/acme/channels/general`. Convex Dashboard → Data confirms zero rows for that channel in `channels`, `messages`, `channelMembers`.

- [ ] **Step 4: Run full automated suite once more**

```bash
npm run test
```

Expected: all tests pass.

- [ ] **Step 5: Report back / fix issues**

If any acceptance step fails, report symptom + step number. Likely classes of bugs:

- Real-time not updating → check `ConvexProviderWithClerk` in `components/ConvexClientProvider.tsx` (Foundation) and JWT template (Foundation).
- Sidebar missing `#general` for existing workspace → the test workspace predates Task 3's webhook update; delete + recreate.
- `loadMore` not firing → verify scroll container has bounded height (`min-h-0` on the flex parent).
- "Not a channel member" on `#general` → membership auto-join didn't run; inspect Convex logs for the `upsertMembership` call.

- [ ] **Step 6: If all ten pass, final commit**

```bash
git add -A
git commit --allow-empty -m "chore: Messaging core E2E acceptance passed"
```

---

## Task 21: Finish — merge + tag

Follow the `superpowers:finishing-a-development-branch` skill. Present Options 1–4 to the user: merge locally, push and open PR, keep as-is, or discard. Expected path: **push `messaging-core` branch → open PR against master**, mirroring the Foundation workflow.

After merge, tag:

```bash
git checkout master
git pull
git tag -a messaging-core-v1 -m "Milestone 3: public channels + messaging core"
git push origin messaging-core-v1
```

---

## Spec ↔ plan coverage check

| Spec section | Task |
|---|---|
| Decisions table | All tasks |
| Scope / non-goals | Plan avoids non-goals by construction |
| Architecture & data flow | Tasks 1–12 (Convex), 13–19 (UI) |
| Schema additions | Task 1 |
| Convex helpers (`assertChannelMember`) | Task 2 |
| Webhook extensions (`upsertMembership`) | Task 3 |
| Webhook extensions (`deleteMembership`) | Task 4 |
| Webhook extensions (`deleteOrganization`) | Task 5 |
| `channels.create` | Task 6 |
| `channels.join` / `leave` | Task 7 |
| `channels.deleteChannel` | Task 8 |
| `channels.listMine` / `getBySlug` / `listBrowsable` | Task 9 |
| `messages.send` | Task 10 |
| `messages.list` | Task 11 |
| `messages.deleteMessage` | Task 12 |
| Two-column layout + redirect | Task 13 |
| `<WorkspaceSidebar>` | Task 14 |
| `<ChannelHeader>` + channel page | Task 15 |
| `<MessageRow>` | Task 16 |
| `<MessageList>` with pagination | Task 17 |
| `<MessageComposer>` | Task 18 |
| `<CreateChannelModal>` + `<BrowseChannelsModal>` | Task 19 |
| Acceptance criteria | Task 20 |
| Testing | Tasks 3–12 (unit) + Task 20 (manual E2E) |
| Open risks — scroll-restore jank | Covered by `useLayoutEffect` in Task 17 |
| Open risks — `_creationTime` tie-breaks | Cursor stability baked into Convex; no code needed |
| Open risks — sidebar reactivity | `listMine` reactivity confirmed; Browse modal fires its own query |
| Open risks — racing slug creates | Accepted; no plan task (defer to polish) |
