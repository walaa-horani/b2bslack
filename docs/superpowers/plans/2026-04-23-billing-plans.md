# Billing Plans Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Free + Pro organization plans via Clerk Billing on top of Messaging core, following [docs/superpowers/specs/2026-04-23-billing-plans-design.md](../specs/2026-04-23-billing-plans-design.md). Two gates: private channels (Pro only) and a 10,000-message history cap per channel (Free).

**Architecture:** Plan/feature state is read from the Clerk session JWT via `ctx.auth.getUserIdentity()` — no Convex mirror, no billing webhooks. One Convex helper `assertFeature()` throws a typed `PaywallError` when the active org lacks a feature. Three gate sites: `channels.create({isPrivate: true})`, `channels.invite` (on private channels), `messages.list` (history cap). UI adds a `/[slug]/settings/billing` route hosting Clerk's `<PricingTable/>`, plus an Upgrade pill, Private checkbox, and history-cap card.

**Tech Stack:** Next.js 16 App Router, React 19, `@clerk/nextjs` 6.39.1 (with Billing enabled), Convex 1.35.1, `convex-test`, `vitest`, Tailwind 4. No new dependencies.

---

## Pre-flight check

- [ ] Messaging core PR #2 merged to `master` → rebase this branch: `git fetch origin && git rebase origin/master`. If PR #2 is still open, keep `messaging-core` as the base and rebase later.
- [ ] Clerk dashboard: Organization Billing is enabled, `free_org` + `pro` plans exist with features `public_channels`, `basic_messaging`, `private_channels`, `unlimited_message_history`.
- [ ] `cd slack-b2b-app && npm run test` passes (49/49 from Messaging core).
- [ ] `npm run build` clean.
- [ ] Have at least two Clerk test users and one test workspace ready for manual E2E.

---

## File structure after Billing plans

```
slack-b2b-app/
├── app/
│   └── [slug]/
│       ├── settings/
│       │   ├── layout.tsx                     ← created (admin guard)
│       │   └── billing/
│       │       └── page.tsx                   ← created (<PricingTable/>)
│       └── ... (rest unchanged)
├── components/
│   └── messaging/
│       ├── WorkspaceSidebar.tsx               ← modified (Upgrade pill + 🔒 icon)
│       ├── ChannelHeader.tsx                  ← modified (Add people on private)
│       ├── CreateChannelModal.tsx             ← modified (Private checkbox)
│       ├── InviteToChannelModal.tsx           ← created
│       ├── MessageList.tsx                    ← modified (history-cap card)
│       └── ... (rest unchanged)
├── hooks/
│   └── useHasFeature.ts                       ← created
└── convex/
    ├── schema.ts                              ← modified (+isPrivate on channels)
    ├── auth.ts                                ← modified (+PaywallError, getPlan, assertFeature)
    ├── auth.test.ts                           ← created
    ├── billing.ts                             ← created (constants)
    ├── channels.ts                            ← modified (isPrivate gate + invite + listChannelMembers + listBrowsable filter)
    ├── channels.test.ts                      ← modified (new cases)
    ├── messages.ts                           ← modified (history cap logic)
    ├── messages.test.ts                      ← modified (cap tests)
    ├── workspace.ts                          ← modified (+listMembers query)
    └── workspace.test.ts                     ← modified (listMembers tests)
```

---

## Task 1: Configure Clerk JWT template + verify claim shape

**Files:**
- No code to commit for this task's user-action parts
- Create (temporary, will be removed in Task 3): `slack-b2b-app/convex/_debug.ts`

**Context:** Clerk ships plan/feature state in the session JWT, but the exact claim path varies between Clerk Billing versions. This task locks in the real shape before we build helpers around it.

- [ ] **Step 1: In the Clerk Dashboard, customize the `convex` JWT template.**

Navigate: Clerk Dashboard → Configure → Sessions → **Customize session token**. Select the **`convex`** template. In the "Claims" JSON, set:

```json
{
  "aud": "convex",
  "org_plan": "{{org.slug}}",
  "org_features": "{{org.public_metadata.features}}"
}
```

Save. (These shortcodes are placeholders — Step 3 will verify what Clerk actually substitutes. Do not rely on these values yet.)

- [ ] **Step 2: Create `slack-b2b-app/convex/_debug.ts`**

```typescript
import { query } from "./_generated/server";

/**
 * TEMPORARY — used in Task 1 to confirm JWT claim shape.
 * Deleted at end of Task 3. Do not call from client code.
 */
export const whatsInMyJwt = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    return identity as unknown as Record<string, unknown>;
  },
});
```

- [ ] **Step 3: Push + invoke the debug query from the Convex dashboard**

```bash
cd c:/dev/b2bslack/slack-b2b-app
npx convex dev --once
```

Open https://dashboard.convex.dev → your deployment → **Functions** tab → `_debug:whatsInMyJwt` → **Run**. Use the dashboard's "Act as identity" feature (or sign in via `localhost:3000` first so a real JWT exists) and trigger from an authenticated session.

Record in your notes:
- What keys are on the returned object. Look for anything containing `plan`, `feature`, `subscription`, `pla`, `fea`, `sub`.
- Whether there's an `o.` prefix (e.g. `o.pla`) or flat keys (e.g. `orgPlan`).
- Whether the shortcodes `{{org.subscription.*}}` or `{{user.public_metadata.*}}` work.

- [ ] **Step 4: Iterate the JWT template until both claims come through**

Based on Step 3 output, adjust the JSON in Clerk and repeat Step 3 until:
- `org_plan` on the identity equals `free_org` or `pro` for a subscribed org.
- `org_features` is an array (or comma-string) including the feature keys for the org's active plan.

Common winners (try in order if the first doesn't work):

```json
{ "org_plan": "{{org.subscription.plan_key}}",   "org_features": "{{org.subscription.features}}" }
```

```json
{ "org_plan": "{{org.public_metadata.plan_key}}", "org_features": "{{org.public_metadata.features}}" }
```

```json
{ "org_plan": "{{org.slug}}", "org_features": "{{user.public_metadata.org_features}}" }
```

If *none* work, fall back: record plan state via a Clerk `subscription.updated` webhook into `organizations.planKey` / `organizations.features` columns and stop using the JWT route. (Spec's Option B.) That's a separate ~2-task patch; pause the plan and escalate.

- [ ] **Step 5: Write down the confirmed shape**

Append one line to the top of `convex/_debug.ts`:

```typescript
// CONFIRMED JWT SHAPE: identity.org_plan: string, identity.org_features: string[]
// (replace with what actually works — snake_case keys match the template JSON)
```

- [ ] **Step 6: Do not commit yet.** The `_debug.ts` file and this comment stay local until Task 3 deletes them.

---

## Task 2: Create `convex/billing.ts` (plan + feature constants)

**Files:**
- Create: `slack-b2b-app/convex/billing.ts`

- [ ] **Step 1: Create `convex/billing.ts`**

```typescript
/**
 * Plan + feature keys as configured in the Clerk Dashboard.
 * These strings are forever — do NOT rename after users subscribe.
 */

export const PLAN_FREE = "free_org";
export const PLAN_PRO = "pro";

export const FEATURE_PUBLIC_CHANNELS = "public_channels";
export const FEATURE_BASIC_MESSAGING = "basic_messaging";
export const FEATURE_PRIVATE_CHANNELS = "private_channels";
export const FEATURE_UNLIMITED_MESSAGE_HISTORY = "unlimited_message_history";

/** The hard cap on messages returned by `messages.list` for Free-plan channels. */
export const FREE_MESSAGE_HISTORY_CAP = 10_000;
```

- [ ] **Step 2: Push**

```bash
npx convex dev --once
```

Expected: `Convex functions ready!`, no errors.

- [ ] **Step 3: Commit**

```bash
git add convex/billing.ts
git commit -m "feat(convex): add billing.ts with plan + feature key constants"
```

---

## Task 3: Add `PaywallError`, `getPlan`, `assertFeature` to `convex/auth.ts` + tests

**Files:**
- Modify: `slack-b2b-app/convex/auth.ts`
- Create: `slack-b2b-app/convex/auth.test.ts`
- Delete: `slack-b2b-app/convex/_debug.ts`

- [ ] **Step 1: Create `convex/auth.test.ts` with failing tests**

```typescript
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import schema from "./schema";
import { PaywallError, assertFeature, getPlan } from "./auth";

const modules = import.meta.glob("./**/*.ts");
const ISSUER = "https://awaited-boxer-54.clerk.accounts.dev";
const TOKEN = `${ISSUER}|user_abc`;

test("getPlan returns null when identity has no org claims", async () => {
  const t = convexTest(schema, modules);
  const asAnon = t.withIdentity({
    tokenIdentifier: TOKEN,
    subject: "user_abc",
    email: "jane@example.com",
  });
  // Run via a temporary test mutation — getPlan takes a ctx.
  const result = await asAnon.run(async (ctx) => await getPlan(ctx));
  expect(result).toBeNull();
});

test("getPlan returns plan + features when identity has them", async () => {
  const t = convexTest(schema, modules);
  const asPro = t.withIdentity({
    tokenIdentifier: TOKEN,
    subject: "user_abc",
    email: "jane@example.com",
    // @ts-expect-error — custom JWT claims not in UserIdentity type
    org_plan: "pro",
    org_features: ["public_channels", "private_channels", "unlimited_message_history"],
  });
  const result = await asPro.run(async (ctx) => await getPlan(ctx));
  expect(result).not.toBeNull();
  expect(result!.planKey).toBe("pro");
  expect(result!.features).toContain("private_channels");
});

test("assertFeature throws PaywallError when feature absent", async () => {
  const t = convexTest(schema, modules);
  const asFree = t.withIdentity({
    tokenIdentifier: TOKEN,
    subject: "user_abc",
    email: "jane@example.com",
    // @ts-expect-error — custom JWT claims not in UserIdentity type
    org_plan: "free_org",
    org_features: ["public_channels", "basic_messaging"],
  });

  await expect(
    asFree.run(async (ctx) => await assertFeature(ctx, "private_channels")),
  ).rejects.toThrow(PaywallError);
});

test("assertFeature succeeds silently when feature present", async () => {
  const t = convexTest(schema, modules);
  const asPro = t.withIdentity({
    tokenIdentifier: TOKEN,
    subject: "user_abc",
    email: "jane@example.com",
    // @ts-expect-error — custom JWT claims not in UserIdentity type
    org_plan: "pro",
    org_features: ["public_channels", "private_channels"],
  });

  await expect(
    asPro.run(async (ctx) => await assertFeature(ctx, "private_channels")),
  ).resolves.toBeUndefined();
});

test("PaywallError carries the featureKey", () => {
  const err = new PaywallError("unlimited_message_history");
  expect(err.name).toBe("PaywallError");
  expect(err.featureKey).toBe("unlimited_message_history");
  expect(err.message).toMatch(/unlimited_message_history/);
});
```

- [ ] **Step 2: Run tests to confirm failure**

```bash
npm run test -- auth
```

Expected: FAIL — `PaywallError`, `getPlan`, `assertFeature` not exported.

- [ ] **Step 3: Append to `convex/auth.ts`**

Append at the bottom of the file:

```typescript
/**
 * Thrown by `assertFeature` when the active org lacks a feature.
 * Clients catch by checking `err.name === "PaywallError"` and read `featureKey`.
 */
export class PaywallError extends Error {
  constructor(public featureKey: string) {
    super(`Feature requires upgrade: ${featureKey}`);
    this.name = "PaywallError";
  }
}

/**
 * Reads plan + features from the active org's JWT claims.
 * Returns null when the caller has no identity or no active org.
 *
 * JWT claim names are set in the Clerk "convex" JWT template; see Task 1
 * of the billing-plans plan for the exact shape.
 */
export async function getPlan(
  ctx: QueryCtx | MutationCtx,
): Promise<{ planKey: string | null; features: string[] } | null> {
  const identity = (await ctx.auth.getUserIdentity()) as
    | (Record<string, unknown> & { org_plan?: string; org_features?: string[] | string })
    | null;
  if (!identity) return null;

  const planKey =
    typeof identity.org_plan === "string" && identity.org_plan.length > 0
      ? identity.org_plan
      : null;

  let features: string[] = [];
  if (Array.isArray(identity.org_features)) {
    features = identity.org_features.filter((f): f is string => typeof f === "string");
  } else if (typeof identity.org_features === "string" && identity.org_features.length > 0) {
    // Some Clerk setups serialize the array as a CSV string.
    features = identity.org_features.split(",").map((s) => s.trim()).filter(Boolean);
  }

  if (planKey === null && features.length === 0) return null;
  return { planKey, features };
}

/**
 * Throws PaywallError(featureKey) when the active org lacks the feature.
 * Used at the top of any mutation/query that gates on a Pro feature.
 */
export async function assertFeature(
  ctx: QueryCtx | MutationCtx,
  featureKey: string,
): Promise<void> {
  const plan = await getPlan(ctx);
  if (!plan || !plan.features.includes(featureKey)) {
    throw new PaywallError(featureKey);
  }
}
```

- [ ] **Step 4: Push + run tests**

```bash
npx convex dev --once
npm run test -- auth
```

Expected: 5 passing tests.

If `t.withIdentity(...)` rejects the custom claims at the TypeScript level, the `@ts-expect-error` comments in the tests silence it. If it rejects at runtime (claims don't make it through to `ctx.auth.getUserIdentity()`), see fallback below.

**Runtime fallback if convex-test drops custom claims:** edit the three affected tests to call `getPlan` / `assertFeature` via a tiny internal test fixture that bypasses the auth layer — add to `convex/auth.ts`:

```typescript
// Only exported for tests; do not call from production code.
export const _setIdentityForTest = (claims: Record<string, unknown>) => {
  (globalThis as { __testIdentity?: Record<string, unknown> }).__testIdentity = claims;
};
```

...and have `getPlan` check `globalThis.__testIdentity` when `ctx.auth.getUserIdentity()` returns null. This is ugly; prefer the direct-claims approach if it works.

- [ ] **Step 5: Delete the `_debug.ts` file from Task 1**

```bash
rm convex/_debug.ts
npx convex dev --once   # re-push without the debug query
```

- [ ] **Step 6: Commit**

```bash
git add convex/auth.ts convex/auth.test.ts convex/_debug.ts
git commit -m "feat(convex): add getPlan + assertFeature + PaywallError"
```

---

## Task 4: Add `isPrivate` column to `channels` schema

**Files:**
- Modify: `slack-b2b-app/convex/schema.ts`

- [ ] **Step 1: Replace the `channels` table definition in `convex/schema.ts`**

Find:
```typescript
  channels: defineTable({
    organizationId: v.id("organizations"),
    slug: v.string(),
    name: v.string(),
    createdBy: v.id("users"),
    isProtected: v.boolean(),
  })
```

Replace with:
```typescript
  channels: defineTable({
    organizationId: v.id("organizations"),
    slug: v.string(),
    name: v.string(),
    createdBy: v.id("users"),
    isProtected: v.boolean(),
    isPrivate: v.boolean(),
  })
```

Keep the two `.index(...)` calls that follow — don't change them.

- [ ] **Step 2: Backfill existing rows**

Create `convex/_migrate.ts` (temporary, deleted after):

```typescript
import { internalMutation } from "./_generated/server";

export const backfillIsPrivate = internalMutation({
  args: {},
  handler: async (ctx) => {
    const channels = await ctx.db.query("channels").take(1000);
    let patched = 0;
    for (const ch of channels) {
      if ((ch as { isPrivate?: boolean }).isPrivate === undefined) {
        await ctx.db.patch(ch._id, { isPrivate: false });
        patched++;
      }
    }
    return { patched, total: channels.length };
  },
});
```

- [ ] **Step 3: Push + run the backfill**

```bash
npx convex dev --once
```

Expected error on push — schema validation will fail because existing rows don't have `isPrivate`. That's expected. To fix:

Modify `convex/schema.ts` temporarily to make `isPrivate` optional:

```typescript
    isPrivate: v.optional(v.boolean()),
```

Push again:
```bash
npx convex dev --once
```

Now run the backfill from the Convex dashboard: Functions → `_migrate:backfillIsPrivate` → Run. Confirm return value shows `patched` matches the number of existing channels.

Then revert `isPrivate` to required (no `v.optional`) in `schema.ts`:
```typescript
    isPrivate: v.boolean(),
```

Push:
```bash
npx convex dev --once
```

Expected: clean push, schema now requires `isPrivate`.

- [ ] **Step 4: Delete `_migrate.ts`**

```bash
rm convex/_migrate.ts
npx convex dev --once
```

- [ ] **Step 5: Run existing tests**

```bash
npm run test
```

Expected: 49/49 still passing (no behavior changes). Some channel tests may need the `isPrivate: false` added to their `ctx.db.insert("channels", ...)` seeds — fix any that fail by adding `isPrivate: false` to the seed objects.

- [ ] **Step 6: Commit**

```bash
git add convex/schema.ts
git commit -m "feat(convex): add isPrivate column to channels table"
```

---

## Task 5: Gate `channels.create` on `private_channels` feature

**Files:**
- Modify: `slack-b2b-app/convex/channels.ts`
- Modify: `slack-b2b-app/convex/channels.test.ts`

- [ ] **Step 1: Append failing tests to `channels.test.ts`**

Append at the bottom of the file:

```typescript
// ---------- isPrivate gate ----------

test("channels.create({isPrivate: true}) on Free org throws PaywallError", async () => {
  const t = convexTest(schema, modules);
  await seedAcme(t);
  const asJane = t.withIdentity({
    tokenIdentifier: TOKEN,
    subject: "user_abc",
    email: "jane@example.com",
    // @ts-expect-error — custom JWT claims
    org_plan: "free_org",
    org_features: ["public_channels", "basic_messaging"],
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
  await seedAcme(t);
  const asJane = t.withIdentity({
    tokenIdentifier: TOKEN,
    subject: "user_abc",
    email: "jane@example.com",
    // @ts-expect-error — custom JWT claims
    org_plan: "pro",
    org_features: ["public_channels", "basic_messaging", "private_channels", "unlimited_message_history"],
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

test("channels.create (no isPrivate) defaults to public on Free", async () => {
  const t = convexTest(schema, modules);
  await seedAcme(t);
  const asJane = t.withIdentity({
    tokenIdentifier: TOKEN,
    subject: "user_abc",
    email: "jane@example.com",
    // @ts-expect-error — custom JWT claims
    org_plan: "free_org",
    org_features: ["public_channels", "basic_messaging"],
  });

  const id = await asJane.mutation(api.channels.create, {
    workspaceSlug: "acme",
    name: "Project Alpha",
    slug: "project-alpha",
  });

  const ch = await t.run(async (ctx) => await ctx.db.get(id));
  expect(ch?.isPrivate).toBe(false);
});
```

- [ ] **Step 2: Run tests to confirm failure**

```bash
npm run test -- channels
```

Expected: 3 new failures — current `channels.create` doesn't accept `isPrivate` and doesn't call `assertFeature`.

- [ ] **Step 3: Update `channels.create` in `convex/channels.ts`**

Find the `create` export and replace it with:

```typescript
export const create = mutation({
  args: {
    workspaceSlug: v.string(),
    name: v.string(),
    slug: v.string(),
    isPrivate: v.optional(v.boolean()),
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

    const isPrivate = args.isPrivate === true;
    if (isPrivate) {
      await assertFeature(ctx, "private_channels");
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
      isPrivate,
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

Add `assertFeature` to the top-of-file imports:

```typescript
import { assertChannelMember, assertFeature, assertMember, ensureUser, getAuthedUser } from "./auth";
```

- [ ] **Step 4: Push + run tests**

```bash
npx convex dev --once
npm run test -- channels
```

Expected: 18 passing tests (15 existing + 3 new).

- [ ] **Step 5: Commit**

```bash
git add convex/channels.ts convex/channels.test.ts
git commit -m "feat(convex): gate channels.create({isPrivate}) on private_channels feature"
```

---

## Task 6: Add `channels.invite` + `channels.listChannelMembers` + tests

**Files:**
- Modify: `slack-b2b-app/convex/channels.ts`
- Modify: `slack-b2b-app/convex/channels.test.ts`

- [ ] **Step 1: Append failing tests**

```typescript
// ---------- invite + listChannelMembers ----------

test("channels.invite adds a channelMembers row on a private channel (Pro)", async () => {
  const t = convexTest(schema, modules);
  const { orgId } = await seedAcme(t);

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

  // Jane creates private #ops as Pro, then invites Bob.
  const asJane = t.withIdentity({
    tokenIdentifier: TOKEN,
    subject: "user_abc",
    email: "jane@example.com",
    // @ts-expect-error — custom JWT claims
    org_plan: "pro",
    org_features: ["private_channels", "unlimited_message_history"],
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
  const { userId: janeId, orgId } = await seedAcme(t);

  // Pre-create a private channel (admin seeded while org was Pro).
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

  // Jane is now on Free and tries to invite Bob — should be blocked.
  const asJaneFree = t.withIdentity({
    tokenIdentifier: TOKEN,
    subject: "user_abc",
    email: "jane@example.com",
    // @ts-expect-error — custom JWT claims
    org_plan: "free_org",
    org_features: ["public_channels", "basic_messaging"],
  });

  await expect(
    asJaneFree.mutation(api.channels.invite, { channelId, userId: bobId }),
  ).rejects.toThrow(/private_channels|upgrade/i);
});

test("channels.invite rejects non-channel-member callers", async () => {
  const t = convexTest(schema, modules);
  const { orgId } = await seedAcme(t);
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
    // @ts-expect-error — custom JWT claims
    org_plan: "pro",
    org_features: ["private_channels"],
  });
  const channelId = await asJane.mutation(api.channels.create, {
    workspaceSlug: "acme",
    name: "Ops",
    slug: "ops",
    isPrivate: true,
  });

  // Bob (not in the channel) tries to invite himself — should fail.
  const asBob = t.withIdentity({
    tokenIdentifier: `${ISSUER}|user_bob`,
    subject: "user_bob",
    email: "bob@example.com",
    // @ts-expect-error — custom JWT claims
    org_plan: "pro",
    org_features: ["private_channels"],
  });
  await expect(
    asBob.mutation(api.channels.invite, { channelId, userId: bobId }),
  ).rejects.toThrow(/Not a channel member/);
});

test("channels.invite rejects non-workspace-member invitee", async () => {
  const t = convexTest(schema, modules);
  await seedAcme(t);
  const asJane = t.withIdentity({
    tokenIdentifier: TOKEN,
    subject: "user_abc",
    email: "jane@example.com",
    // @ts-expect-error — custom JWT claims
    org_plan: "pro",
    org_features: ["private_channels"],
  });
  const channelId = await asJane.mutation(api.channels.create, {
    workspaceSlug: "acme",
    name: "Ops",
    slug: "ops",
    isPrivate: true,
  });

  // Stranger exists as a user but is NOT a workspace member.
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
  const { userId: janeId, orgId } = await seedAcme(t);
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
    // @ts-expect-error — custom JWT claims
    org_plan: "pro",
    org_features: ["private_channels"],
  });
  const result = await asJane.query(api.channels.listChannelMembers, { channelId });
  expect(result).toHaveLength(1);
  expect(result[0]).toBe(janeId);
});
```

- [ ] **Step 2: Run tests to confirm failure**

```bash
npm run test -- channels
```

Expected: 5 new failures (`invite`, `listChannelMembers` not defined).

- [ ] **Step 3: Append to `convex/channels.ts`**

Append below `deleteChannel`:

```typescript
export const invite = mutation({
  args: {
    channelId: v.id("channels"),
    userId: v.id("users"),
  },
  handler: async (ctx, args) => {
    const caller = await ensureUser(ctx);
    const { channel } = await assertChannelMember(ctx, caller._id, args.channelId);

    if (channel.isPrivate) {
      await assertFeature(ctx, "private_channels");
    }

    const org = await ctx.db.get(channel.organizationId);
    if (!org) throw new Error("Channel belongs to an unknown workspace.");
    await assertMember(ctx, args.userId, org.slug);

    const existing = await ctx.db
      .query("channelMembers")
      .withIndex("by_user_and_channel", (q) =>
        q.eq("userId", args.userId).eq("channelId", channel._id),
      )
      .unique();
    if (existing) return existing._id;

    return await ctx.db.insert("channelMembers", {
      channelId: channel._id,
      userId: args.userId,
      organizationId: channel.organizationId,
    });
  },
});

export const listChannelMembers = query({
  args: { channelId: v.id("channels") },
  handler: async (ctx, args) => {
    const user = await getAuthedUser(ctx);
    if (!user) throw new Error("Not authenticated");
    await assertChannelMember(ctx, user._id, args.channelId);

    const rows = await ctx.db
      .query("channelMembers")
      .withIndex("by_channel", (q) => q.eq("channelId", args.channelId))
      .take(500);
    return rows.map((r) => r.userId);
  },
});
```

- [ ] **Step 4: Push + run tests**

```bash
npx convex dev --once
npm run test -- channels
```

Expected: 23 passing tests in `channels.test.ts` (18 + 5 new).

- [ ] **Step 5: Commit**

```bash
git add convex/channels.ts convex/channels.test.ts
git commit -m "feat(convex): add channels.invite + channels.listChannelMembers"
```

---

## Task 7: Filter private channels from `channels.listBrowsable`

**Files:**
- Modify: `slack-b2b-app/convex/channels.ts`
- Modify: `slack-b2b-app/convex/channels.test.ts`

- [ ] **Step 1: Append failing test**

```typescript
test("channels.listBrowsable excludes private channels", async () => {
  const t = convexTest(schema, modules);
  const { userId: janeId, orgId } = await seedAcme(t);

  // Bob — workspace member, not in any channel.
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
    // Seed a public and a private channel. Jane is in both; Bob is in neither.
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
    // @ts-expect-error — custom JWT claims
    org_plan: "pro",
    org_features: ["private_channels"],
  });

  const browsable = await asBob.query(api.channels.listBrowsable, {
    workspaceSlug: "acme",
  });
  expect(browsable).toHaveLength(1);
  expect(browsable[0].slug).toBe("random");
  expect(browsable.find((c) => c.slug === "ops")).toBeUndefined();
});
```

- [ ] **Step 2: Run tests to confirm failure**

```bash
npm run test -- channels
```

Expected: 1 new failure — private channel "ops" currently appears in browsable list.

- [ ] **Step 3: Update `channels.listBrowsable` in `convex/channels.ts`**

Find the `listBrowsable` export and change its final `return` to filter out private:

```typescript
    return allChannels
      .filter((c) => !c.isPrivate && !joinedIds.has(c._id))
      .sort((a, b) => a.name.localeCompare(b.name));
```

- [ ] **Step 4: Push + run tests**

```bash
npx convex dev --once
npm run test -- channels
```

Expected: 24 passing tests.

- [ ] **Step 5: Commit**

```bash
git add convex/channels.ts convex/channels.test.ts
git commit -m "feat(convex): exclude private channels from listBrowsable"
```

---

## Task 8: Add `workspace.listMembers` query + tests

**Files:**
- Modify: `slack-b2b-app/convex/workspace.ts`
- Modify: `slack-b2b-app/convex/workspace.test.ts`

- [ ] **Step 1: Append failing tests to `workspace.test.ts`**

Append at the bottom of the file:

```typescript
// ---------- listMembers ----------

test("workspace.listMembers returns all members with user info", async () => {
  const t = convexTest(schema, modules);
  const { userId: janeId, orgId } = await seedAcme(t);
  await t.run(async (ctx) => {
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
});

test("workspace.listMembers rejects non-members", async () => {
  const t = convexTest(schema, modules);
  await seedAcme(t);
  const asStranger = t.withIdentity({
    tokenIdentifier: `${ISSUER}|user_stranger`,
    subject: "user_stranger",
    email: "stranger@example.com",
  });
  await expect(
    asStranger.query(api.workspace.listMembers, { workspaceSlug: "acme" }),
  ).rejects.toThrow(/Not a member/);
});
```

At the top of the file, add a `seedAcme` helper matching the one used by `channels.test.ts` (it may already exist — if so, reuse it). Required imports: `convexTest`, `expect`, `test`, `api`, `schema`. The token identifier uses `const ISSUER = "https://awaited-boxer-54.clerk.accounts.dev"` and `const TOKEN = \`${ISSUER}|user_abc\``. If the file doesn't already have a `seedAcme`, copy it verbatim from `channels.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run tests to confirm failure**

```bash
npm run test -- workspace
```

Expected: 2 new failures — `api.workspace.listMembers` not defined.

- [ ] **Step 3: Append to `convex/workspace.ts`**

```typescript
export const listMembers = query({
  args: { workspaceSlug: v.string() },
  handler: async (ctx, args) => {
    const user = await getAuthedUser(ctx);
    if (!user) throw new Error("Not authenticated");
    const { org } = await assertMember(ctx, user._id, args.workspaceSlug);

    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_organization", (q) => q.eq("organizationId", org._id))
      .take(200);

    const users = await Promise.all(memberships.map((m) => ctx.db.get(m.userId)));

    return memberships
      .map((m, i) => {
        const u = users[i];
        if (!u) return null;
        return {
          membershipId: m._id,
          role: m.role,
          user: {
            _id: u._id,
            email: u.email,
            name: u.name ?? null,
            imageUrl: u.imageUrl ?? null,
          },
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .sort((a, b) => (a.user.name ?? a.user.email).localeCompare(b.user.name ?? b.user.email));
  },
});
```

- [ ] **Step 4: Push + run tests**

```bash
npx convex dev --once
npm run test -- workspace
```

Expected: 2 new passing tests (count depends on existing workspace tests).

- [ ] **Step 5: Commit**

```bash
git add convex/workspace.ts convex/workspace.test.ts
git commit -m "feat(convex): add workspace.listMembers query"
```

---

## Task 9: Enforce 10k-message history cap in `messages.list` + tests

**Files:**
- Modify: `slack-b2b-app/convex/messages.ts`
- Modify: `slack-b2b-app/convex/messages.test.ts`

- [ ] **Step 1: Append failing tests to `messages.test.ts`**

```typescript
// ---------- history cap ----------

test("messages.list on Free org with 9500 messages returns all, cappedByPlan=false", async () => {
  const t = convexTest(schema, modules);
  const { userId, channelId } = await seedAcmeWithGeneral(t);
  await t.run(async (ctx) => {
    for (let i = 0; i < 9_500; i++) {
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
    // @ts-expect-error — custom JWT claims
    org_plan: "free_org",
    org_features: ["public_channels", "basic_messaging"],
  });
  // Paginate 500 at a time until done.
  let cursor: string | null = null;
  let total = 0;
  let anyCapped = false;
  for (let i = 0; i < 30; i++) {
    const p = await asJane.query(api.messages.list, {
      channelId,
      paginationOpts: { numItems: 500, cursor },
    });
    total += p.page.length;
    anyCapped = anyCapped || p.cappedByPlan;
    if (p.isDone) break;
    cursor = p.continueCursor;
  }
  expect(total).toBe(9_500);
  expect(anyCapped).toBe(false);
});

test("messages.list on Free org with 10500 messages caps at 10000, cappedByPlan=true", async () => {
  const t = convexTest(schema, modules);
  const { userId, channelId } = await seedAcmeWithGeneral(t);
  await t.run(async (ctx) => {
    for (let i = 0; i < 10_500; i++) {
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
    // @ts-expect-error — custom JWT claims
    org_plan: "free_org",
    org_features: ["public_channels", "basic_messaging"],
  });

  let cursor: string | null = null;
  let total = 0;
  let sawCap = false;
  for (let i = 0; i < 30; i++) {
    const p: { page: unknown[]; continueCursor: string; isDone: boolean; cappedByPlan: boolean } =
      await asJane.query(api.messages.list, {
        channelId,
        paginationOpts: { numItems: 500, cursor },
      });
    total += p.page.length;
    sawCap = sawCap || p.cappedByPlan;
    if (p.isDone) break;
    cursor = p.continueCursor;
  }
  expect(total).toBe(10_000);
  expect(sawCap).toBe(true);
});

test("messages.list on Pro org with 10500 messages returns all, cappedByPlan=false", async () => {
  const t = convexTest(schema, modules);
  const { userId, channelId } = await seedAcmeWithGeneral(t);
  await t.run(async (ctx) => {
    for (let i = 0; i < 10_500; i++) {
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
    // @ts-expect-error — custom JWT claims
    org_plan: "pro",
    org_features: ["public_channels", "basic_messaging", "private_channels", "unlimited_message_history"],
  });

  let cursor: string | null = null;
  let total = 0;
  let anyCapped = false;
  for (let i = 0; i < 30; i++) {
    const p = await asJane.query(api.messages.list, {
      channelId,
      paginationOpts: { numItems: 500, cursor },
    });
    total += p.page.length;
    anyCapped = anyCapped || p.cappedByPlan;
    if (p.isDone) break;
    cursor = p.continueCursor;
  }
  expect(total).toBe(10_500);
  expect(anyCapped).toBe(false);
});
```

(These three tests insert a lot of rows. They'll take a few seconds each in convex-test — acceptable.)

- [ ] **Step 2: Run tests to confirm failure**

```bash
npm run test -- messages
```

Expected: 3 new failures — `cappedByPlan` is undefined on the current `list` return, and the 10500-message Free case returns 10500 instead of 10000.

- [ ] **Step 3: Update `messages.list` in `convex/messages.ts`**

At the top of the file, add imports:

```typescript
import { getPlan, assertChannelMember, ensureUser } from "./auth";
import {
  FEATURE_UNLIMITED_MESSAGE_HISTORY,
  FREE_MESSAGE_HISTORY_CAP,
} from "./billing";
```

Replace the `list` export with:

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
    if (!user) throw new Error("Not a channel member: no user record");
    await assertChannelMember(ctx, user._id, args.channelId);

    const plan = await getPlan(ctx);
    const hasUnlimited =
      plan?.features.includes(FEATURE_UNLIMITED_MESSAGE_HISTORY) ?? false;

    let cutoffCreationTime: number | null = null;
    let cappedByPlan = false;
    if (!hasUnlimited) {
      const capProbe = await ctx.db
        .query("messages")
        .withIndex("by_channel", (q) => q.eq("channelId", args.channelId))
        .order("desc")
        .take(FREE_MESSAGE_HISTORY_CAP + 1);
      if (capProbe.length > FREE_MESSAGE_HISTORY_CAP) {
        cutoffCreationTime = capProbe[FREE_MESSAGE_HISTORY_CAP - 1]._creationTime;
        cappedByPlan = true;
      }
    }

    let q = ctx.db
      .query("messages")
      .withIndex("by_channel", (q) => q.eq("channelId", args.channelId))
      .order("desc");
    if (cutoffCreationTime !== null) {
      const cutoff = cutoffCreationTime;
      q = q.filter((f) => f.gte(f.field("_creationTime"), cutoff));
    }
    const result = await q.paginate(args.paginationOpts);

    // Author join — unchanged from messaging-core.
    const authorIds = [...new Set(result.page.map((m) => m.userId))];
    const authors = await Promise.all(authorIds.map((id) => ctx.db.get(id)));
    const authorById = new Map(
      authors
        .filter((a): a is NonNullable<typeof a> => a !== null)
        .map((a) => [a._id, a]),
    );

    return {
      ...result,
      cappedByPlan,
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

- [ ] **Step 4: Push + run tests**

```bash
npx convex dev --once
npm run test -- messages
```

Expected: 11 passing tests (8 existing + 3 new). Note: the 10,500-row seed may take a few seconds.

- [ ] **Step 5: Commit**

```bash
git add convex/messages.ts convex/messages.test.ts
git commit -m "feat(convex): enforce 10k-message history cap on Free plan in messages.list"
```

---

## Task 10: Client-side `useHasFeature` hook

**Files:**
- Create: `slack-b2b-app/hooks/useHasFeature.ts`

- [ ] **Step 1: Create the directory + file**

```bash
mkdir -p hooks
```

Create `slack-b2b-app/hooks/useHasFeature.ts`:

```typescript
"use client";

import { useAuth } from "@clerk/nextjs";

/**
 * Returns whether the active Clerk organization has a feature, read from the
 * session claims. Returns `undefined` while session is loading.
 *
 * Claim name must match what Task 1 configured in the Clerk "convex" JWT
 * template. If that differs from `org_features`, update the key below.
 */
export function useHasFeature(featureKey: string): boolean | undefined {
  const { isLoaded, sessionClaims } = useAuth();
  if (!isLoaded) return undefined;

  const claims = sessionClaims as
    | (Record<string, unknown> & { org_features?: string[] | string })
    | null
    | undefined;
  const raw = claims?.org_features;
  if (raw === undefined || raw === null) return false;

  const features = Array.isArray(raw)
    ? raw
    : typeof raw === "string"
      ? raw.split(",").map((s) => s.trim()).filter(Boolean)
      : [];

  return features.includes(featureKey);
}
```

- [ ] **Step 2: Verify build**

```bash
rm -rf .next
npm run build
```

Expected: build passes. The hook isn't consumed yet; this just type-checks it.

- [ ] **Step 3: Commit**

```bash
git add hooks/useHasFeature.ts
git commit -m "feat: add useHasFeature client hook (reads Clerk session claims)"
```

---

## Task 11: Admin-only `/[slug]/settings/billing` route with `<PricingTable/>`

**Files:**
- Create: `slack-b2b-app/app/[slug]/settings/layout.tsx`
- Create: `slack-b2b-app/app/[slug]/settings/billing/page.tsx`

- [ ] **Step 1: Create `app/[slug]/settings/layout.tsx` (admin guard)**

```bash
mkdir -p "app/[slug]/settings/billing"
```

Create `app/[slug]/settings/layout.tsx`:

```tsx
"use client";

import { useQuery } from "convex/react";
import { useRouter } from "next/navigation";
import { use, useEffect } from "react";
import { api } from "@/convex/_generated/api";

export default function SettingsLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = use(params);
  const router = useRouter();
  const overview = useQuery(api.workspace.getOverview, { slug });

  useEffect(() => {
    if (overview && overview.role !== "org:admin") {
      router.replace(`/${slug}`);
    }
  }, [overview, slug, router]);

  if (overview === undefined) {
    return (
      <div className="flex-1 flex items-center justify-center text-zinc-400">
        Loading…
      </div>
    );
  }
  if (overview.role !== "org:admin") {
    return (
      <div className="flex-1 flex items-center justify-center text-zinc-400">
        Redirecting…
      </div>
    );
  }
  return <div className="flex flex-col flex-1 p-6 overflow-auto">{children}</div>;
}
```

- [ ] **Step 2: Create `app/[slug]/settings/billing/page.tsx`**

```tsx
"use client";

import { PricingTable } from "@clerk/nextjs";
import { use } from "react";

export default function BillingPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = use(params);
  return (
    <div className="max-w-4xl w-full mx-auto">
      <h1 className="text-2xl font-semibold mb-2">Billing</h1>
      <p className="text-sm text-zinc-500 mb-6">
        Manage your workspace's subscription. Changes take effect within about a minute.
      </p>
      <PricingTable
        newSubscriptionRedirectUrl={`/${slug}/channels/general`}
      />
    </div>
  );
}
```

- [ ] **Step 3: Verify build**

```bash
rm -rf .next
npm run build
```

Expected: `/[slug]/settings/billing` in the routes list; build passes.

- [ ] **Step 4: Commit**

```bash
git add "app/[slug]/settings"
git commit -m "feat(ui): add admin-only /[slug]/settings/billing with <PricingTable/>"
```

---

## Task 12: Sidebar — Upgrade pill + 🔒 icon on private channels

**Files:**
- Modify: `slack-b2b-app/components/messaging/WorkspaceSidebar.tsx`

- [ ] **Step 1: Modify `WorkspaceSidebar.tsx`**

At the top, add the import:

```tsx
import { useHasFeature } from "@/hooks/useHasFeature";
```

Inside the component body, just after `const [browseOpen, setBrowseOpen] = useState(false);`:

```tsx
  const hasUnlimited = useHasFeature("unlimited_message_history");
```

Change the channel-list rendering (inside the `ul` mapping) from:

```tsx
                    # {ch.slug}
```

to:

```tsx
                    {ch.isPrivate ? "🔒" : "#"} {ch.slug}
```

Just above the `<div className="p-3 border-t flex items-center justify-between">` footer row, insert the Upgrade pill:

```tsx
      {hasUnlimited === false && (
        <Link
          href={`/${slug}/settings/billing`}
          className="mx-3 mb-2 text-xs text-center rounded border px-2 py-1 bg-gradient-to-r from-blue-50 to-purple-50 hover:from-blue-100 hover:to-purple-100 dark:from-blue-950 dark:to-purple-950"
        >
          ⚡ Upgrade to Pro
        </Link>
      )}
```

- [ ] **Step 2: Verify build**

```bash
rm -rf .next
npm run build
```

Expected: build passes.

- [ ] **Step 3: Commit**

```bash
git add components/messaging/WorkspaceSidebar.tsx
git commit -m "feat(ui): sidebar shows Upgrade pill on Free + 🔒 for private channels"
```

---

## Task 13: `CreateChannelModal` — Private checkbox (Pro-gated)

**Files:**
- Modify: `slack-b2b-app/components/messaging/CreateChannelModal.tsx`

- [ ] **Step 1: Modify `CreateChannelModal.tsx`**

At the top, add:

```tsx
import { useHasFeature } from "@/hooks/useHasFeature";
```

Inside the component:

```tsx
  const canPrivate = useHasFeature("private_channels");
  const [isPrivate, setIsPrivate] = useState(false);
```

In the `onSubmit` handler, change the `create(...)` call to pass `isPrivate`:

```tsx
      await create({ workspaceSlug, name, slug, isPrivate });
```

In the JSX, between the name input `<label>` and the URL preview `<div>`, insert:

```tsx
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            disabled={!canPrivate}
            checked={isPrivate && !!canPrivate}
            onChange={(e) => setIsPrivate(e.target.checked)}
            className="mt-0.5"
          />
          <span className={canPrivate ? "" : "text-zinc-400"}>
            Make private
            {!canPrivate && (
              <span className="ml-2 text-xs rounded bg-purple-100 text-purple-700 px-1.5 py-0.5">
                Pro
              </span>
            )}
            <span className="block text-xs text-zinc-500 mt-0.5">
              Only invited people can see and send messages.
              {!canPrivate && (
                <>
                  {" "}
                  <a
                    href={`/${workspaceSlug}/settings/billing`}
                    target="_blank"
                    rel="noreferrer"
                    className="underline"
                  >
                    Upgrade to Pro
                  </a>
                </>
              )}
            </span>
          </span>
        </label>
```

After the successful `create`, reset the checkbox:

```tsx
      setName("");
      setIsPrivate(false);
```

- [ ] **Step 2: Verify build**

```bash
rm -rf .next
npm run build
```

Expected: build passes.

- [ ] **Step 3: Commit**

```bash
git add components/messaging/CreateChannelModal.tsx
git commit -m "feat(ui): CreateChannelModal gains a Private checkbox (Pro-only)"
```

---

## Task 14: `InviteToChannelModal` component

**Files:**
- Create: `slack-b2b-app/components/messaging/InviteToChannelModal.tsx`

- [ ] **Step 1: Create the file**

```tsx
"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

export function InviteToChannelModal({
  open,
  workspaceSlug,
  channelId,
  onClose,
}: {
  open: boolean;
  workspaceSlug: string;
  channelId: Id<"channels">;
  onClose: () => void;
}) {
  const members = useQuery(
    api.workspace.listMembers,
    open ? { workspaceSlug } : "skip",
  );
  const existingIds = useQuery(
    api.channels.listChannelMembers,
    open ? { channelId } : "skip",
  );
  const invite = useMutation(api.channels.invite);
  const [search, setSearch] = useState("");
  const [addingId, setAddingId] = useState<string | null>(null);

  const candidates = useMemo(() => {
    if (!members || !existingIds) return [];
    const set = new Set(existingIds);
    const q = search.trim().toLowerCase();
    return members
      .filter((m) => !set.has(m.user._id))
      .filter((m) => {
        if (!q) return true;
        const n = (m.user.name ?? "").toLowerCase();
        const e = m.user.email.toLowerCase();
        return n.includes(q) || e.includes(q);
      });
  }, [members, existingIds, search]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-20 bg-black/40 flex items-center justify-center">
      <div className="bg-white dark:bg-zinc-950 rounded-lg shadow-xl p-6 w-full max-w-md flex flex-col gap-3 max-h-[80vh]">
        <h2 className="text-lg font-semibold">Add people</h2>
        <input
          autoFocus
          type="text"
          placeholder="Search by name or email…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="rounded border px-3 py-2 text-sm dark:bg-zinc-900"
        />
        <div className="flex-1 overflow-y-auto">
          {members === undefined || existingIds === undefined ? (
            <div className="text-sm text-zinc-400">Loading…</div>
          ) : candidates.length === 0 ? (
            <div className="text-sm text-zinc-400">
              No one else to add.
            </div>
          ) : (
            <ul className="flex flex-col gap-1">
              {candidates.map((m) => (
                <li
                  key={m.user._id}
                  className="flex items-center justify-between border rounded px-3 py-2"
                >
                  <div>
                    <div className="text-sm font-medium">
                      {m.user.name ?? m.user.email}
                    </div>
                    <div className="text-xs text-zinc-500">{m.user.email}</div>
                  </div>
                  <button
                    disabled={addingId === m.user._id}
                    onClick={async () => {
                      setAddingId(m.user._id);
                      try {
                        await invite({ channelId, userId: m.user._id });
                      } catch (err: unknown) {
                        const msg =
                          err instanceof Error ? err.message : "Failed";
                        alert(msg);
                      } finally {
                        setAddingId(null);
                      }
                    }}
                    className="text-sm px-3 py-1 rounded bg-foreground text-background disabled:opacity-50"
                  >
                    {addingId === m.user._id ? "Adding…" : "Add"}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="flex justify-end">
          <button className="px-3 py-1 rounded text-sm" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify build**

```bash
rm -rf .next
npm run build
```

Expected: build passes. (Component isn't consumed yet; Task 15 wires it in.)

- [ ] **Step 3: Commit**

```bash
git add components/messaging/InviteToChannelModal.tsx
git commit -m "feat(ui): add InviteToChannelModal (private-channel member picker)"
```

---

## Task 15: `ChannelHeader` — Add-people button on private channels

**Files:**
- Modify: `slack-b2b-app/components/messaging/ChannelHeader.tsx`
- Modify: `slack-b2b-app/app/[slug]/channels/[channel]/page.tsx`

- [ ] **Step 1: Modify `ChannelHeader.tsx`**

Add new props `isPrivate`, `onAddPeople`:

Change the signature:

```tsx
export function ChannelHeader({
  name,
  slug,
  memberCount,
  isProtected,
  isPrivate,
  isAdmin,
  onDelete,
  onAddPeople,
}: {
  name: string;
  slug: string;
  memberCount: number;
  isProtected: boolean;
  isPrivate: boolean;
  isAdmin: boolean;
  onDelete: () => Promise<void>;
  onAddPeople?: () => void;
}) {
```

Change the name line to show 🔒 for private:

```tsx
        <h1 className="font-semibold">
          <span className="text-zinc-400">{isPrivate ? "🔒" : "#"}</span> {name}
        </h1>
```

Just before the `{isAdmin && !isProtected && (...)}` kebab-menu block, insert an Add-people button for private channels:

```tsx
      {isPrivate && onAddPeople && (
        <button
          className="text-xs underline text-zinc-500 mr-2"
          onClick={onAddPeople}
        >
          Add people
        </button>
      )}
```

(It sits next to the existing admin kebab — both can appear on an admin's view of a private channel.)

- [ ] **Step 2: Modify `app/[slug]/channels/[channel]/page.tsx` to pass the new props**

In `ChannelContent`, after `const deleteChannel = useMutation(api.channels.deleteChannel);`:

```tsx
  const [inviteOpen, setInviteOpen] = useState(false);
```

Add the import at the top:

```tsx
import { InviteToChannelModal } from "@/components/messaging/InviteToChannelModal";
```

And `useState`:

```tsx
import { use, useState, useEffect } from "react";
```

(Leave existing imports intact.)

Change the return's outer JSX from:

```tsx
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
```

to:

```tsx
  return (
    <div className="flex flex-col flex-1 min-h-0">
      <ChannelHeader
        name={data.channel.name}
        slug={data.channel.slug}
        memberCount={data.memberCount}
        isProtected={data.channel.isProtected}
        isPrivate={data.channel.isPrivate}
        isAdmin={isAdmin}
        onDelete={onDeleteChannel}
        onAddPeople={data.channel.isPrivate ? () => setInviteOpen(true) : undefined}
      />
      <MessageList channelId={data.channel._id} />
      <MessageComposer channelId={data.channel._id} />
      <InviteToChannelModal
        open={inviteOpen}
        workspaceSlug={slug}
        channelId={data.channel._id}
        onClose={() => setInviteOpen(false)}
      />
    </div>
  );
```

- [ ] **Step 3: Verify build**

```bash
rm -rf .next
npm run build
```

Expected: build passes.

- [ ] **Step 4: Commit**

```bash
git add components/messaging/ChannelHeader.tsx "app/[slug]/channels/[channel]/page.tsx"
git commit -m "feat(ui): ChannelHeader gets Add-people button for private channels"
```

---

## Task 16: `MessageList` — history-cap card

**Files:**
- Modify: `slack-b2b-app/components/messaging/MessageList.tsx`

- [ ] **Step 1: Extract `cappedByPlan` from the paginated results**

`usePaginatedQuery` doesn't expose per-page extras directly, but each item in `results` is a row of the page. The extra field `cappedByPlan` lives on the page object, not on individual rows. We handle this by adding a separate one-shot query.

Create a thin helper query first — add to `convex/messages.ts`:

```typescript
export const historyStatus = query({
  args: { channelId: v.id("channels") },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");
    const user = await ctx.db
      .query("users")
      .withIndex("by_token_identifier", (q) =>
        q.eq("tokenIdentifier", identity.tokenIdentifier),
      )
      .unique();
    if (!user) throw new Error("Not a channel member: no user record");
    await assertChannelMember(ctx, user._id, args.channelId);

    const plan = await getPlan(ctx);
    const hasUnlimited =
      plan?.features.includes(FEATURE_UNLIMITED_MESSAGE_HISTORY) ?? false;
    if (hasUnlimited) return { cappedByPlan: false };

    const probe = await ctx.db
      .query("messages")
      .withIndex("by_channel", (q) => q.eq("channelId", args.channelId))
      .order("desc")
      .take(FREE_MESSAGE_HISTORY_CAP + 1);
    return { cappedByPlan: probe.length > FREE_MESSAGE_HISTORY_CAP };
  },
});
```

Push:

```bash
npx convex dev --once
```

- [ ] **Step 2: Modify `MessageList.tsx`**

Add imports:

```tsx
import Link from "next/link";
import { useParams } from "next/navigation";
```

Inside the component, right after `const { results, status, loadMore } = usePaginatedQuery(...)`:

```tsx
  const historyStatus = useQuery(api.messages.historyStatus, { channelId });
  const params = useParams<{ slug: string }>();
```

In the JSX, inside the main `<div>` scroll container, at the top of the rendering (just above `{status === "LoadingFirstPage" ? (...)`), add the cap card:

```tsx
      {status === "Exhausted" && historyStatus?.cappedByPlan && (
        <div className="mx-4 my-4 p-4 border border-dashed rounded text-center">
          <div className="text-sm font-medium mb-1">
            You've reached your 10,000-message history.
          </div>
          <div className="text-xs text-zinc-500 mb-3">
            Upgrade to Pro to see older messages.
          </div>
          <Link
            href={`/${params.slug}/settings/billing`}
            className="text-sm underline text-blue-600"
          >
            Upgrade to Pro →
          </Link>
        </div>
      )}
```

- [ ] **Step 3: Verify build**

```bash
rm -rf .next
npm run build
```

Expected: build passes.

- [ ] **Step 4: Commit**

```bash
git add convex/messages.ts components/messaging/MessageList.tsx
git commit -m "feat: show Upgrade card at top of MessageList when history cap hit"
```

---

## Task 17: Full test suite + build sanity check

**Files:** none.

- [ ] **Step 1: Run full test suite**

```bash
npm run test
```

Expected: all tests pass. Rough count: 49 from messaging-core + ~5 auth + ~6 channels + ~2 workspace + ~3 messages = ~65 tests. Exact count depends on how the individual tests decomposed.

- [ ] **Step 2: Full build**

```bash
rm -rf .next
npm run build
```

Expected: clean build. Routes include:
- `/[slug]`
- `/[slug]/channels/[channel]`
- `/[slug]/members`
- `/[slug]/settings/billing`
- `/create-workspace`
- `/sign-in/[[...sign-in]]`
- `/sign-up/[[...sign-up]]`

- [ ] **Step 3: If anything fails, fix before moving to manual E2E**

Don't proceed to Task 18 until tests + build are green.

---

## Task 18: Manual E2E — the 10 acceptance steps

**Files:** none.

- [ ] **Step 1: Start dev servers**

```bash
cd c:/dev/b2bslack/slack-b2b-app
npm run dev
```

Wait for both Convex backend and Next.js frontend to boot.

- [ ] **Step 2: Walk the 10 steps (from the spec)**

Use two browser windows (one normal, one incognito). Log in as two different Clerk test users.

- [ ] **Step 2a** — New Free workspace (create via the existing flow): sidebar shows "⚡ Upgrade to Pro" pill at the bottom. Click it → lands on `/[slug]/settings/billing`.
- [ ] **Step 2b** — Open Create-channel modal: "Make private" checkbox is present but **disabled**, with a purple "Pro" badge and an "Upgrade to Pro" link opening the billing page in a new tab.
- [ ] **Step 2c** — Log in as a non-admin member, visit `/[slug]/settings/billing` directly → page shows "Redirecting…" briefly then lands on `/[slug]`.
- [ ] **Step 2d** — Back as admin, visit `/[slug]/settings/billing` → `<PricingTable/>` renders Free and Pro with correct prices ($14.99/mo, $119.88/yr) and a 3-day trial badge on Pro.
- [ ] **Step 2e** — Click Subscribe on Pro, go through Clerk's Stripe **test** checkout (`4242 4242 4242 4242` / any future expiry / any CVC) → redirects to `/[slug]/channels/general`. Within ~60 seconds the Upgrade pill disappears and the Private checkbox becomes enabled.
- [ ] **Step 2f** — Create a private channel `engineering` via the now-enabled Private checkbox → sidebar shows `🔒 engineering`; URL is `/[slug]/channels/engineering`.
- [ ] **Step 2g** — Click "Add people" in `#engineering`, pick your second test user (Bob). Switch to Bob's incognito window → `🔒 engineering` now appears in his sidebar in real time.
- [ ] **Step 2h** — Bob opens "Browse channels" → `engineering` is **not** listed. Only public channels appear.
- [ ] **Step 2i** — To test the history cap: seed 10,050 messages into a channel via the Convex Dashboard (Functions → messages:send run 10,050 times, or run a one-off internal mutation you add + delete for this step). Downgrade via Clerk Dashboard → within ~60s, scroll to the top of the channel → the "Reached 10,000-message history" card appears with a working Upgrade link. Re-subscribe to Pro → card disappears; older 50 messages become visible.
- [ ] **Step 2j** — After downgrade (from step 2i): existing `🔒 engineering` channel **remains visible** in the sidebar for both Jane and Bob; attempting to create another private channel fails with the paywall hint; "Add people" in `#engineering` now shows the alert error "Feature requires upgrade: private_channels".

- [ ] **Step 3: Run the full suite again for parity**

```bash
npm run test
```

Expected: all tests pass.

- [ ] **Step 4: If any step fails, debug**

Common issues:
- Pill doesn't disappear after Pro → JWT template not wired correctly; re-verify Task 1's Step 4.
- "Add people" → invite throws on Pro → `assertFeature` is reading wrong claim; verify `getPlan` output with a temporary `console.log` in the mutation.
- `<PricingTable/>` empty → Clerk dashboard plans not "publicly available"; toggle the "Publicly available" switch on each plan + features.
- Downgrade doesn't propagate → wait full 60s; or sign-out/sign-in forces JWT refresh.

- [ ] **Step 5: Acceptance passed — empty commit**

```bash
git commit --allow-empty -m "chore: Billing plans E2E acceptance passed"
```

---

## Task 19: Finish — merge + tag

Follow the `superpowers:finishing-a-development-branch` skill. Expected path: **push `billing-plans` → open PR against master** (rebase first if messaging-core has merged).

After merge, tag:

```bash
git checkout master
git pull
git tag -a billing-plans-v1 -m "Milestone 4: Free + Pro plans via Clerk Billing"
git push origin billing-plans-v1
```

---

## Spec ↔ plan coverage check

| Spec section | Task(s) |
|---|---|
| JWT claim wiring | Task 1 |
| `convex/billing.ts` constants | Task 2 |
| `getPlan` / `assertFeature` / `PaywallError` | Task 3 |
| `useHasFeature` client hook | Task 10 |
| Schema `isPrivate` + backfill | Task 4 |
| `channels.create` gate | Task 5 |
| `channels.invite` + `listChannelMembers` | Task 6 |
| `channels.listBrowsable` filter | Task 7 |
| `workspace.listMembers` | Task 8 |
| `messages.list` history cap | Task 9 |
| `messages.historyStatus` helper | Task 16 (pulled in for the UI card) |
| Admin-only `/settings/billing` route | Task 11 |
| Sidebar Upgrade pill + 🔒 icon | Task 12 |
| `CreateChannelModal` Private checkbox | Task 13 |
| `InviteToChannelModal` | Task 14 |
| `ChannelHeader` Add-people | Task 15 |
| `MessageList` history-cap card | Task 16 |
| Manual E2E (10 steps) | Task 18 |
| Finish — merge + tag | Task 19 |
