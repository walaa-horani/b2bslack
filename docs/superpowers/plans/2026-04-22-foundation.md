# Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the end-to-end auth + tenancy + Clerk↔Convex sync pipeline described in [docs/superpowers/specs/2026-04-22-foundation-design.md](../specs/2026-04-22-foundation-design.md).

**Architecture:** Next.js 16 App Router inside `slack-b2b-app/`, Clerk for identity + organizations + invitations, Convex for persistent data. Clerk→Convex sync combines JIT helpers (executed inside every mutation) and a Svix-verified webhook endpoint on Convex. Path-based tenancy at `/[slug]`.

**Tech Stack:** Next.js 16.2.x, React 19, `@clerk/nextjs` 6.39.1, `@clerk/clerk-react` 5.61.x, Convex 1.35.x, `convex-test`, `vitest` (edge-runtime env), `svix`, Tailwind 4.

---

## Pre-flight check — do this before starting

Before Task 0, confirm the following manually (copy each line's result into chat so we have a record):

- [ ] **Clerk Dashboard → User & Authentication** shows Email, Google, GitHub enabled. *(user said yes)*
- [ ] **Clerk Dashboard → JWT Templates** contains a template named exactly `convex`. *(user confirmed screenshot)*
- [ ] **Clerk Dashboard → Organizations** is **enabled**; "Allow any authenticated user to create organizations" is checked. *(unverified — do this now)*
- [ ] **Convex Dashboard → Settings → Environment Variables** currently has `ISSUER` set (user confirmed); task 4 will rename it.
- [ ] You're working from a fresh `git status` with no uncommitted changes.

---

## File structure after Foundation

```
c:/dev/b2bslack/
├── AGENTS.md, CLAUDE.md, README.md        (unchanged, root meta)
├── docs/superpowers/
│   ├── specs/2026-04-22-foundation-design.md
│   └── plans/2026-04-22-foundation.md     (this file)
└── slack-b2b-app/                          ← all app code lives here
    ├── .env.local                          ← gains Clerk keys
    ├── package.json                        ← modified (deps + scripts)
    ├── proxy.ts                            ← modified (new routing)
    ├── vitest.config.ts                    ← created
    ├── app/
    │   ├── layout.tsx                      ← modified (Clerk appearance, SyncUser)
    │   ├── page.tsx                        ← replaced (landing)
    │   ├── sign-in/[[...sign-in]]/page.tsx ← created
    │   ├── sign-up/[[...sign-up]]/page.tsx ← created
    │   ├── create-workspace/page.tsx       ← created
    │   └── [slug]/
    │       ├── layout.tsx                  ← created (SyncActiveOrg)
    │       ├── page.tsx                    ← created (workspace home)
    │       └── members/page.tsx            ← created (OrganizationProfile)
    ├── components/
    │   ├── ConvexClientProvider.tsx        (unchanged)
    │   ├── SyncUser.tsx                    ← created
    │   └── SyncActiveOrg.tsx               ← created
    └── convex/
        ├── schema.ts                       ← replaced
        ├── auth.config.ts                  ← modified
        ├── auth.ts                         ← created (JIT helpers)
        ├── users.ts                        ← created (public ensureUser)
        ├── workspace.ts                    ← created (getOverview query)
        ├── clerkSync.ts                    ← created (internal mutations)
        ├── http.ts                         ← created (webhook endpoint)
        ├── myFunctions.ts                  ← DELETED
        ├── auth.test.ts                    ← created
        ├── clerkSync.test.ts               ← created
        ├── workspace.test.ts               ← created
        └── http.test.ts                    ← created
```

Each file has one responsibility. Tests live next to the Convex module they cover.

---

## Task 0: Repo housekeeping + env consolidation

**Files:**
- Delete: outer `c:/dev/b2bslack/app/`, `next.config.ts`, `package.json`, `package-lock.json`, `pnpm-lock.yaml`, `next-env.d.ts`, `tsconfig.json`, `eslint.config.mjs`, `postcss.config.mjs`, `public/`, `.env`, `.next/`
- Modify: `slack-b2b-app/.env.local` (add Clerk keys)

- [ ] **Step 1: Copy Clerk keys into the inner project's env file**

Read the current outer `c:/dev/b2bslack/.env`, take its two lines, append them to `c:/dev/b2bslack/slack-b2b-app/.env.local`. After the edit, `slack-b2b-app/.env.local` should contain all five entries:

```bash
CONVEX_DEPLOYMENT=dev:spotted-rook-538 # team: walaa-horani, project: slack-b2b-app
NEXT_PUBLIC_CONVEX_URL=https://spotted-rook-538.convex.cloud
NEXT_PUBLIC_CONVEX_SITE_URL=https://spotted-rook-538.convex.site
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_YXdhaXRlZC1ib3hlci01NC5jbGVyay5hY2NvdW50cy5kZXYk
CLERK_SECRET_KEY=sk_test_fIFteOmrLrvpIsFoW9U5xlB6lxdWMXt2fOqcryVe09
```

- [ ] **Step 2: Delete the stale outer Next.js scaffolding**

Run from `c:/dev/b2bslack`:

```bash
rm -rf app .next public node_modules
rm -f next.config.ts next-env.d.ts tsconfig.json eslint.config.mjs postcss.config.mjs package.json package-lock.json pnpm-lock.yaml .env
```

Keep: `.git/`, `.gitignore`, `AGENTS.md`, `CLAUDE.md`, `README.md`, `docs/`, `slack-b2b-app/`.

- [ ] **Step 3: Verify the deletion**

Run `ls -la c:/dev/b2bslack`. Expected output contains only: `.git/`, `.gitignore`, `AGENTS.md`, `CLAUDE.md`, `README.md`, `docs/`, `slack-b2b-app/`. If extra files remain, delete them.

- [ ] **Step 4: Commit**

```bash
cd c:/dev/b2bslack
git add -A
git commit -m "chore: consolidate on slack-b2b-app/, remove stale outer scaffolding"
```

---

## Task 1: Verify Next 16 `proxy.ts` + Clerk 6.39.1 runtime compatibility (RISK CHECK)

**Why:** Next 16 renamed `middleware.ts` → `proxy.ts` and dropped edge-runtime support. Clerk's `clerkMiddleware` in 6.39.1 was written for edge. Before we build anything else, we need to know if this pair works. If it doesn't, we either upgrade Clerk or pick a different strategy — and we need to know *now*, not after three tasks of wasted work.

**Files:** none modified.

- [ ] **Step 1: Start the dev server**

```bash
cd c:/dev/b2bslack/slack-b2b-app
npm install
npm run dev
```

The `predev` script will run `convex dev --until-success` first. If it prompts, accept defaults. Dev server starts at http://localhost:3000.

- [ ] **Step 2: Hit the root URL**

From a browser (or `curl -I http://localhost:3000`), request `http://localhost:3000/`.
Expected: HTTP 200, starter page renders, no runtime errors in the terminal.

- [ ] **Step 3: Inspect the terminal for edge/runtime warnings**

Scan the dev server output. Look for:

- `Error: The Edge Runtime does not support ...` → **compatibility is broken**.
- `clerkMiddleware is deprecated ...` or `proxy.ts ...` warnings → note and continue.
- Silent success → compatibility is fine.

- [ ] **Step 4: Branch on the result**

- **If compatible (no edge errors):** Continue to Task 2. No code change.
- **If broken:** Stop. Report the exact error to the user. Two mitigations to weigh: (a) bump `@clerk/nextjs` to a version that supports Next 16 proxy (verify `convex/react-clerk` compatibility in the same breath), or (b) hand-roll a minimal session-cookie check in `proxy.ts` and keep Clerk server calls out of it. Do not proceed with Task 2 until this is resolved.

- [ ] **Step 5: Commit**

No code to commit. Stop the dev server (Ctrl-C) and record the finding in chat.

---

## Task 2: Install test tooling and add `svix`

**Files:**
- Modify: `slack-b2b-app/package.json`
- Create: `slack-b2b-app/vitest.config.ts`

- [ ] **Step 1: Install runtime + dev dependencies**

```bash
cd c:/dev/b2bslack/slack-b2b-app
npm install svix
npm install -D vitest @edge-runtime/vm convex-test
```

- [ ] **Step 2: Add the test script to `package.json`**

Open `slack-b2b-app/package.json`, add under `scripts`:

```json
"test": "vitest run",
"test:watch": "vitest"
```

Final `scripts` section:

```json
"scripts": {
  "dev": "npm-run-all --parallel dev:frontend dev:backend",
  "dev:frontend": "next dev",
  "dev:backend": "convex dev",
  "predev": "convex dev --until-success && convex dashboard",
  "build": "next build",
  "start": "next start",
  "lint": "eslint .",
  "test": "vitest run",
  "test:watch": "vitest"
}
```

- [ ] **Step 3: Create `vitest.config.ts`**

Write `slack-b2b-app/vitest.config.ts`:

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "edge-runtime",
    include: ["convex/**/*.test.ts"],
    server: { deps: { inline: ["convex-test"] } },
  },
});
```

- [ ] **Step 4: Run the test suite to confirm tooling works (zero tests is fine)**

```bash
npm run test
```

Expected: exit code 0, "No test files found" or "0 passed". If vitest fails to start, fix the config before continuing.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json vitest.config.ts
git commit -m "chore: add vitest + convex-test + svix for Foundation tests"
```

---

## Task 3: Replace Convex schema + remove starter code

**Files:**
- Replace: `slack-b2b-app/convex/schema.ts`
- Delete: `slack-b2b-app/convex/myFunctions.ts`
- Modify: `slack-b2b-app/app/page.tsx` (remove references to `api.myFunctions`)

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
});
```

- [ ] **Step 2: Replace `app/page.tsx` with a minimal landing that imports nothing from Convex**

Full file contents:

```tsx
import Link from "next/link";
import { SignedIn, SignedOut, SignInButton, SignUpButton } from "@clerk/nextjs";

export default function Home() {
  return (
    <main className="flex flex-col flex-1 items-center justify-center gap-6 p-8">
      <h1 className="text-4xl font-bold">Slack B2B</h1>
      <p className="text-zinc-500">A multi-tenant team chat app.</p>
      <SignedOut>
        <div className="flex gap-3">
          <SignInButton mode="modal">
            <button className="rounded-md bg-foreground px-4 py-2 text-background">
              Sign in
            </button>
          </SignInButton>
          <SignUpButton mode="modal">
            <button className="rounded-md border px-4 py-2">Sign up</button>
          </SignUpButton>
        </div>
      </SignedOut>
      <SignedIn>
        <Link href="/create-workspace" className="underline">
          Go to your workspace
        </Link>
      </SignedIn>
    </main>
  );
}
```

(The middleware will redirect `/create-workspace` to `/[activeOrgSlug]` if the signed-in user already has an org — so this link is safe.)

- [ ] **Step 3: Delete the starter Convex module**

```bash
rm slack-b2b-app/convex/myFunctions.ts
```

- [ ] **Step 4: Push the schema change to Convex dev**

```bash
cd slack-b2b-app
npx convex dev --once
```

Expected: "Convex functions ready!" with no type errors. Convex will delete the `numbers` table. If it complains about `myFunctions.ts` references, re-check Step 2 removed all imports.

- [ ] **Step 5: Confirm the landing page still builds**

```bash
npm run build
```

Expected: build succeeds. If it fails on the Clerk imports, verify `.env.local` from Task 0 contains `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`.

- [ ] **Step 6: Commit**

```bash
git add convex/schema.ts app/page.tsx
git rm convex/myFunctions.ts
git commit -m "feat(convex): replace starter schema with users/organizations/memberships"
```

---

## Task 4: Wire Clerk issuer in `auth.config.ts`; rename Convex env var

**Files:**
- Modify: `slack-b2b-app/convex/auth.config.ts`

- [ ] **Step 1: User action — rename Convex env var `ISSUER` → `CLERK_JWT_ISSUER_DOMAIN`**

In the browser, open Convex Dashboard → Settings → Environment Variables for deployment `spotted-rook-538`. Rename the `ISSUER` entry to `CLERK_JWT_ISSUER_DOMAIN` (keep the same value: `https://awaited-boxer-54.clerk.accounts.dev`). Save.

Confirm in chat that the variable now appears as `CLERK_JWT_ISSUER_DOMAIN`.

- [ ] **Step 2: Replace `convex/auth.config.ts`**

Full file contents:

```typescript
import { AuthConfig } from "convex/server";

export default {
  providers: [
    {
      domain: process.env.CLERK_JWT_ISSUER_DOMAIN!,
      applicationID: "convex",
    },
  ],
} satisfies AuthConfig;
```

- [ ] **Step 3: Push and confirm no auth errors**

```bash
cd slack-b2b-app
npx convex dev --once
```

Expected: "Convex functions ready!" with no warnings about missing env vars. If it complains that `CLERK_JWT_ISSUER_DOMAIN` is unset, re-check Step 1 was actually saved.

- [ ] **Step 4: Commit**

```bash
git add convex/auth.config.ts
git commit -m "feat(convex): wire Clerk issuer in auth.config.ts"
```

---

## Task 5: JIT helper — `ensureUser`

**Files:**
- Create: `slack-b2b-app/convex/auth.ts`
- Create: `slack-b2b-app/convex/auth.test.ts`

- [ ] **Step 1: Write the failing test**

Full file `convex/auth.test.ts`:

```typescript
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const TOKEN_ID = "https://awaited-boxer-54.clerk.accounts.dev|user_abc";

test("ensureUser inserts a user row when the identity is new", async () => {
  const t = convexTest(schema, modules);
  const asJane = t.withIdentity({
    tokenIdentifier: TOKEN_ID,
    subject: "user_abc",
    email: "jane@example.com",
    name: "Jane Doe",
    pictureUrl: "https://example.com/jane.png",
  });

  const user = await asJane.mutation(
    // @ts-expect-error — users.ensureUser added in Task 11
    require("./_generated/api").api.users.ensureUser,
    {},
  );

  expect(user.email).toBe("jane@example.com");
  expect(user.clerkUserId).toBe("user_abc");
  expect(user.tokenIdentifier).toBe(TOKEN_ID);
});

test("ensureUser is idempotent — two calls return the same row", async () => {
  const t = convexTest(schema, modules);
  const asJane = t.withIdentity({
    tokenIdentifier: TOKEN_ID,
    subject: "user_abc",
    email: "jane@example.com",
  });

  const first = await asJane.mutation(
    // @ts-expect-error — users.ensureUser added in Task 11
    require("./_generated/api").api.users.ensureUser,
    {},
  );
  const second = await asJane.mutation(
    // @ts-expect-error — users.ensureUser added in Task 11
    require("./_generated/api").api.users.ensureUser,
    {},
  );

  expect(first._id).toEqual(second._id);

  const all = await t.run(async (ctx) => await ctx.db.query("users").collect());
  expect(all).toHaveLength(1);
});
```

Note: `users.ensureUser` public mutation is added in Task 11. We write the test now so Task 11 has a target. Tests will be skipped/red until then.

- [ ] **Step 2: Create `convex/auth.ts` with `ensureUser` helper**

Full file contents:

```typescript
import { MutationCtx } from "./_generated/server";
import { Doc } from "./_generated/dataModel";

/**
 * Insert-if-missing. Call at the top of any mutation that needs an authenticated user.
 * Throws if the caller is unauthenticated.
 */
export async function ensureUser(ctx: MutationCtx): Promise<Doc<"users">> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("Not authenticated");

  const existing = await ctx.db
    .query("users")
    .withIndex("by_token_identifier", (q) =>
      q.eq("tokenIdentifier", identity.tokenIdentifier),
    )
    .unique();
  if (existing) return existing;

  const id = await ctx.db.insert("users", {
    clerkUserId: identity.subject,
    tokenIdentifier: identity.tokenIdentifier,
    email: identity.email ?? "",
    name: identity.name,
    imageUrl: identity.pictureUrl,
  });
  const inserted = await ctx.db.get(id);
  if (!inserted) throw new Error("Failed to insert user");
  return inserted;
}
```

- [ ] **Step 3: Commit (tests will go green at Task 11)**

```bash
git add convex/auth.ts convex/auth.test.ts
git commit -m "feat(convex): add ensureUser JIT helper + tests"
```

---

## Task 6: JIT helpers — `getAuthedUser` + `assertMember`

**Files:**
- Modify: `slack-b2b-app/convex/auth.ts`

- [ ] **Step 1: Add `getAuthedUser` and `assertMember` to `convex/auth.ts`**

Replace the entire file with:

```typescript
import { QueryCtx, MutationCtx } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";

/**
 * Insert-if-missing. Call at the top of any mutation that needs an authenticated user.
 * Throws if the caller is unauthenticated.
 */
export async function ensureUser(ctx: MutationCtx): Promise<Doc<"users">> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("Not authenticated");

  const existing = await ctx.db
    .query("users")
    .withIndex("by_token_identifier", (q) =>
      q.eq("tokenIdentifier", identity.tokenIdentifier),
    )
    .unique();
  if (existing) return existing;

  const id = await ctx.db.insert("users", {
    clerkUserId: identity.subject,
    tokenIdentifier: identity.tokenIdentifier,
    email: identity.email ?? "",
    name: identity.name,
    imageUrl: identity.pictureUrl,
  });
  const inserted = await ctx.db.get(id);
  if (!inserted) throw new Error("Failed to insert user");
  return inserted;
}

/**
 * Read-only variant for queries. Returns null if the user row has not been
 * JIT-created yet (first query after sign-up, before any mutation has run).
 */
export async function getAuthedUser(ctx: QueryCtx): Promise<Doc<"users"> | null> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return null;
  return await ctx.db
    .query("users")
    .withIndex("by_token_identifier", (q) =>
      q.eq("tokenIdentifier", identity.tokenIdentifier),
    )
    .unique();
}

/**
 * Throws if the user is not a member of the workspace identified by `slug`.
 * Returns the org and membership row so callers can read the role.
 */
export async function assertMember(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
  slug: string,
): Promise<{ org: Doc<"organizations">; membership: Doc<"memberships"> }> {
  const org = await ctx.db
    .query("organizations")
    .withIndex("by_slug", (q) => q.eq("slug", slug))
    .unique();
  if (!org) throw new Error(`Unknown workspace: ${slug}`);

  const membership = await ctx.db
    .query("memberships")
    .withIndex("by_user_and_organization", (q) =>
      q.eq("userId", userId).eq("organizationId", org._id),
    )
    .unique();
  if (!membership) throw new Error(`Not a member of ${slug}`);

  return { org, membership };
}
```

- [ ] **Step 2: Add tests for `getAuthedUser` and `assertMember`**

Append to `convex/auth.test.ts` (after existing tests):

```typescript
test("getAuthedUser returns null when the user row hasn't been synced yet", async () => {
  const t = convexTest(schema, modules);
  const asJane = t.withIdentity({
    tokenIdentifier: TOKEN_ID,
    subject: "user_abc",
    email: "jane@example.com",
  });

  const user = await asJane.query(
    // @ts-expect-error — workspace.whoami added in Task 11
    require("./_generated/api").api.workspace.whoami,
    {},
  );
  expect(user).toBeNull();
});

test("assertMember throws for non-members, returns org+membership for members", async () => {
  const t = convexTest(schema, modules);

  const { userId, orgId, membershipId } = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      clerkUserId: "user_abc",
      tokenIdentifier: TOKEN_ID,
      email: "jane@example.com",
    });
    const orgId = await ctx.db.insert("organizations", {
      clerkOrgId: "org_123",
      slug: "acme",
      name: "Acme",
    });
    const membershipId = await ctx.db.insert("memberships", {
      userId,
      organizationId: orgId,
      clerkMembershipId: "orgmem_1",
      role: "org:admin",
    });
    return { userId, orgId, membershipId };
  });

  // Member path: getOverview succeeds (added in Task 11).
  const asJane = t.withIdentity({
    tokenIdentifier: TOKEN_ID,
    subject: "user_abc",
    email: "jane@example.com",
  });
  const overview = await asJane.query(
    // @ts-expect-error — workspace.getOverview added in Task 11
    require("./_generated/api").api.workspace.getOverview,
    { slug: "acme" },
  );
  expect(overview.role).toBe("org:admin");

  // Non-member path: different org slug throws.
  await expect(
    asJane.query(
      // @ts-expect-error — workspace.getOverview added in Task 11
      require("./_generated/api").api.workspace.getOverview,
      { slug: "unknown-slug" },
    ),
  ).rejects.toThrow(/Unknown workspace/);
});
```

- [ ] **Step 3: Commit**

```bash
git add convex/auth.ts convex/auth.test.ts
git commit -m "feat(convex): add getAuthedUser + assertMember helpers"
```

---

## Task 7: Webhook internal mutations — `upsertUser` / `deleteUser`

**Files:**
- Create: `slack-b2b-app/convex/clerkSync.ts`
- Create: `slack-b2b-app/convex/clerkSync.test.ts`

- [ ] **Step 1: Write the failing test**

Full file `convex/clerkSync.test.ts`:

```typescript
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

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
    issuerDomain: "https://awaited-boxer-54.clerk.accounts.dev",
  });

  const users = await t.run(
    async (ctx) => await ctx.db.query("users").collect(),
  );
  expect(users).toHaveLength(1);
  expect(users[0].clerkUserId).toBe("user_abc");
  expect(users[0].email).toBe("jane@example.com");
  expect(users[0].name).toBe("Jane Doe");
  expect(users[0].tokenIdentifier).toBe(
    "https://awaited-boxer-54.clerk.accounts.dev|user_abc",
  );
});

test("upsertUser is idempotent — calling twice produces one row", async () => {
  const t = convexTest(schema, modules);
  const args = {
    data: {
      id: "user_abc",
      email_addresses: [{ email_address: "jane@example.com" }],
      first_name: "Jane",
      last_name: "Doe",
    },
    issuerDomain: "https://awaited-boxer-54.clerk.accounts.dev",
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
    issuerDomain: "https://awaited-boxer-54.clerk.accounts.dev",
  });
  await t.mutation(internal.clerkSync.upsertUser, {
    data: {
      id: "user_abc",
      email_addresses: [{ email_address: "jane.new@example.com" }],
      first_name: "Jane",
      last_name: "Smith",
    },
    issuerDomain: "https://awaited-boxer-54.clerk.accounts.dev",
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
  const { userId } = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      clerkUserId: "user_abc",
      tokenIdentifier: "issuer|user_abc",
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
    return { userId };
  });

  await t.mutation(internal.clerkSync.deleteUser, { clerkUserId: "user_abc" });

  const users = await t.run(
    async (ctx) => await ctx.db.query("users").collect(),
  );
  const memberships = await t.run(
    async (ctx) => await ctx.db.query("memberships").collect(),
  );
  expect(users).toHaveLength(0);
  expect(memberships).toHaveLength(0);
});
```

- [ ] **Step 2: Run the test to confirm it fails**

```bash
cd slack-b2b-app
npm run test -- clerkSync
```

Expected: FAIL with "Cannot find module './_generated/api'.clerkSync" or similar.

- [ ] **Step 3: Create `convex/clerkSync.ts` with `upsertUser` + `deleteUser`**

Full file contents:

```typescript
import { v } from "convex/values";
import { internalMutation } from "./_generated/server";

/**
 * Clerk event payload shapes we care about (subset of Clerk's JSON).
 * Kept minimal on purpose — adding fields here should be deliberate.
 */
const userData = v.object({
  id: v.string(), // "user_xxx"
  email_addresses: v.array(
    v.object({ email_address: v.string() }),
  ),
  first_name: v.optional(v.union(v.string(), v.null())),
  last_name: v.optional(v.union(v.string(), v.null())),
  image_url: v.optional(v.union(v.string(), v.null())),
});

function fullName(first?: string | null, last?: string | null): string | undefined {
  const joined = [first, last].filter(Boolean).join(" ").trim();
  return joined || undefined;
}

export const upsertUser = internalMutation({
  args: {
    data: userData,
    issuerDomain: v.string(),
  },
  handler: async (ctx, { data, issuerDomain }) => {
    const tokenIdentifier = `${issuerDomain}|${data.id}`;
    const email = data.email_addresses[0]?.email_address ?? "";
    const name = fullName(data.first_name, data.last_name);
    const imageUrl = data.image_url ?? undefined;

    const existing = await ctx.db
      .query("users")
      .withIndex("by_clerk_user_id", (q) => q.eq("clerkUserId", data.id))
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, {
        email,
        name,
        imageUrl,
        tokenIdentifier,
      });
      return existing._id;
    }
    return await ctx.db.insert("users", {
      clerkUserId: data.id,
      tokenIdentifier,
      email,
      name,
      imageUrl,
    });
  },
});

export const deleteUser = internalMutation({
  args: { clerkUserId: v.string() },
  handler: async (ctx, { clerkUserId }) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerk_user_id", (q) => q.eq("clerkUserId", clerkUserId))
      .unique();
    if (!user) return;

    // Cascade memberships.
    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .take(256);
    for (const m of memberships) await ctx.db.delete(m._id);

    await ctx.db.delete(user._id);
  },
});
```

- [ ] **Step 4: Run tests to verify pass**

```bash
npm run test -- clerkSync
```

Expected: 4 passing tests in `clerkSync.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add convex/clerkSync.ts convex/clerkSync.test.ts
git commit -m "feat(convex): add upsertUser + deleteUser internal mutations"
```

---

## Task 8: Webhook internal mutations — `upsertOrganization` / `deleteOrganization`

**Files:**
- Modify: `slack-b2b-app/convex/clerkSync.ts`
- Modify: `slack-b2b-app/convex/clerkSync.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `convex/clerkSync.test.ts`:

```typescript
test("upsertOrganization inserts then updates", async () => {
  const t = convexTest(schema, modules);
  await t.mutation(internal.clerkSync.upsertOrganization, {
    data: { id: "org_1", slug: "acme", name: "Acme", image_url: null },
  });
  await t.mutation(internal.clerkSync.upsertOrganization, {
    data: { id: "org_1", slug: "acme-corp", name: "Acme Corp", image_url: null },
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
      tokenIdentifier: "issuer|user_abc",
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
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npm run test -- clerkSync
```

Expected: FAIL with `internal.clerkSync.upsertOrganization` not defined.

- [ ] **Step 3: Append `upsertOrganization` + `deleteOrganization` to `convex/clerkSync.ts`**

Append to the existing file:

```typescript
const organizationData = v.object({
  id: v.string(),
  slug: v.string(),
  name: v.string(),
  image_url: v.optional(v.union(v.string(), v.null())),
});

export const upsertOrganization = internalMutation({
  args: { data: organizationData },
  handler: async (ctx, { data }) => {
    const imageUrl = data.image_url ?? undefined;

    const existing = await ctx.db
      .query("organizations")
      .withIndex("by_clerk_org_id", (q) => q.eq("clerkOrgId", data.id))
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, {
        slug: data.slug,
        name: data.name,
        imageUrl,
      });
      return existing._id;
    }
    return await ctx.db.insert("organizations", {
      clerkOrgId: data.id,
      slug: data.slug,
      name: data.name,
      imageUrl,
    });
  },
});

export const deleteOrganization = internalMutation({
  args: { clerkOrgId: v.string() },
  handler: async (ctx, { clerkOrgId }) => {
    const org = await ctx.db
      .query("organizations")
      .withIndex("by_clerk_org_id", (q) => q.eq("clerkOrgId", clerkOrgId))
      .unique();
    if (!org) return;

    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_organization", (q) => q.eq("organizationId", org._id))
      .take(256);
    for (const m of memberships) await ctx.db.delete(m._id);

    await ctx.db.delete(org._id);
  },
});
```

- [ ] **Step 4: Run tests to verify pass**

```bash
npm run test -- clerkSync
```

Expected: 6 passing tests.

- [ ] **Step 5: Commit**

```bash
git add convex/clerkSync.ts convex/clerkSync.test.ts
git commit -m "feat(convex): add upsertOrganization + deleteOrganization"
```

---

## Task 9: Webhook internal mutations — `upsertMembership` / `deleteMembership` (with retry for out-of-order events)

**Files:**
- Modify: `slack-b2b-app/convex/clerkSync.ts`
- Modify: `slack-b2b-app/convex/clerkSync.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `convex/clerkSync.test.ts`:

```typescript
test("upsertMembership inserts when user+org exist", async () => {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    await ctx.db.insert("users", {
      clerkUserId: "user_abc",
      tokenIdentifier: "issuer|user_abc",
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

test("upsertMembership is idempotent + reflects role change", async () => {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    await ctx.db.insert("users", {
      clerkUserId: "user_abc",
      tokenIdentifier: "issuer|user_abc",
      email: "jane@example.com",
    });
    await ctx.db.insert("organizations", {
      clerkOrgId: "org_1",
      slug: "acme",
      name: "Acme",
    });
  });
  const args = {
    data: {
      id: "orgmem_1",
      organization: { id: "org_1" },
      public_user_data: { user_id: "user_abc" },
      role: "org:member",
    },
    attempts: 0,
  };
  await t.mutation(internal.clerkSync.upsertMembership, args);
  await t.mutation(internal.clerkSync.upsertMembership, {
    ...args,
    data: { ...args.data, role: "org:admin" },
  });

  const mems = await t.run(
    async (ctx) => await ctx.db.query("memberships").collect(),
  );
  expect(mems).toHaveLength(1);
  expect(mems[0].role).toBe("org:admin");
});

test("upsertMembership gives up after 5 attempts when parents are missing", async () => {
  const t = convexTest(schema, modules);
  // No users/orgs inserted — parents permanently missing.
  // Scheduled retries do not fire in convex-test by default; we assert the
  // mutation returns without inserting and does not throw.
  await t.mutation(internal.clerkSync.upsertMembership, {
    data: {
      id: "orgmem_1",
      organization: { id: "org_missing" },
      public_user_data: { user_id: "user_missing" },
      role: "org:member",
    },
    attempts: 5, // already at max
  });
  const mems = await t.run(
    async (ctx) => await ctx.db.query("memberships").collect(),
  );
  expect(mems).toHaveLength(0);
});

test("deleteMembership removes the row", async () => {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      clerkUserId: "user_abc",
      tokenIdentifier: "issuer|user_abc",
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
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npm run test -- clerkSync
```

Expected: FAIL — mutations not defined.

- [ ] **Step 3: Append `upsertMembership` + `deleteMembership` to `convex/clerkSync.ts`**

Append to the existing file:

```typescript
import { internal } from "./_generated/api";

const membershipData = v.object({
  id: v.string(),
  organization: v.object({ id: v.string() }),
  public_user_data: v.object({ user_id: v.string() }),
  role: v.string(),
});

const MAX_MEMBERSHIP_RETRIES = 5;

export const upsertMembership = internalMutation({
  args: {
    data: membershipData,
    attempts: v.number(),
  },
  handler: async (ctx, { data, attempts }) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerk_user_id", (q) =>
        q.eq("clerkUserId", data.public_user_data.user_id),
      )
      .unique();
    const org = await ctx.db
      .query("organizations")
      .withIndex("by_clerk_org_id", (q) =>
        q.eq("clerkOrgId", data.organization.id),
      )
      .unique();

    // Out-of-order webhook: parent rows not yet present. Re-schedule up to 5 times.
    if (!user || !org) {
      if (attempts >= MAX_MEMBERSHIP_RETRIES) {
        console.error(
          `upsertMembership giving up on ${data.id} after ${attempts} attempts: user=${!!user} org=${!!org}`,
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

    const existing = await ctx.db
      .query("memberships")
      .withIndex("by_clerk_membership_id", (q) =>
        q.eq("clerkMembershipId", data.id),
      )
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, { role: data.role });
      return existing._id;
    }
    return await ctx.db.insert("memberships", {
      userId: user._id,
      organizationId: org._id,
      clerkMembershipId: data.id,
      role: data.role,
    });
  },
});

export const deleteMembership = internalMutation({
  args: { clerkMembershipId: v.string() },
  handler: async (ctx, { clerkMembershipId }) => {
    const m = await ctx.db
      .query("memberships")
      .withIndex("by_clerk_membership_id", (q) =>
        q.eq("clerkMembershipId", clerkMembershipId),
      )
      .unique();
    if (m) await ctx.db.delete(m._id);
  },
});
```

- [ ] **Step 4: Run tests to verify pass**

```bash
npm run test -- clerkSync
```

Expected: 10 passing tests in `clerkSync.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add convex/clerkSync.ts convex/clerkSync.test.ts
git commit -m "feat(convex): add upsertMembership (with retry) + deleteMembership"
```

---

## Task 10: Webhook HTTP endpoint — `convex/http.ts`

**Files:**
- Create: `slack-b2b-app/convex/http.ts`
- Create: `slack-b2b-app/convex/http.test.ts`

- [ ] **Step 1: Write failing signature tests**

Full file `convex/http.test.ts`:

```typescript
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { Webhook } from "svix";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const SECRET = "whsec_testsecretvalue00000000000000000000000000";

function sign(body: string) {
  const wh = new Webhook(SECRET);
  const msgId = "msg_" + Math.random().toString(36).slice(2);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = wh.sign(msgId, new Date(), body);
  return { "svix-id": msgId, "svix-timestamp": timestamp, "svix-signature": signature };
}

async function post(
  t: ReturnType<typeof convexTest>,
  body: string,
  headers: Record<string, string>,
) {
  return await t.fetch("/clerk-webhook", {
    method: "POST",
    body,
    headers: { "content-type": "application/json", ...headers },
  });
}

test("rejects unsigned requests", async () => {
  const t = convexTest(schema, modules);
  t.env.set("CLERK_WEBHOOK_SECRET", SECRET);
  t.env.set(
    "CLERK_JWT_ISSUER_DOMAIN",
    "https://awaited-boxer-54.clerk.accounts.dev",
  );
  const res = await post(t, "{}", {});
  expect(res.status).toBe(400);
});

test("rejects tampered body", async () => {
  const t = convexTest(schema, modules);
  t.env.set("CLERK_WEBHOOK_SECRET", SECRET);
  t.env.set(
    "CLERK_JWT_ISSUER_DOMAIN",
    "https://awaited-boxer-54.clerk.accounts.dev",
  );
  const body = JSON.stringify({
    type: "user.created",
    data: { id: "user_abc", email_addresses: [{ email_address: "a@b.co" }] },
  });
  const headers = sign(body);
  const res = await post(t, body + "tampered", headers);
  expect(res.status).toBe(400);
});

test("accepts a valid user.created event and creates a user row", async () => {
  const t = convexTest(schema, modules);
  t.env.set("CLERK_WEBHOOK_SECRET", SECRET);
  t.env.set(
    "CLERK_JWT_ISSUER_DOMAIN",
    "https://awaited-boxer-54.clerk.accounts.dev",
  );
  const body = JSON.stringify({
    type: "user.created",
    data: {
      id: "user_abc",
      email_addresses: [{ email_address: "jane@example.com" }],
      first_name: "Jane",
      last_name: "Doe",
    },
  });
  const res = await post(t, body, sign(body));
  expect(res.status).toBe(200);

  const users = await t.run(
    async (ctx) => await ctx.db.query("users").collect(),
  );
  expect(users).toHaveLength(1);
  expect(users[0].email).toBe("jane@example.com");
});
```

- [ ] **Step 2: Run the test to confirm it fails**

```bash
npm run test -- http
```

Expected: FAIL (endpoint not defined).

- [ ] **Step 3: Create `convex/http.ts`**

Full file contents:

```typescript
import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { Webhook } from "svix";
import { internal } from "./_generated/api";

type ClerkEvent =
  | { type: "user.created" | "user.updated"; data: any }
  | { type: "user.deleted"; data: { id: string } }
  | { type: "organization.created" | "organization.updated"; data: any }
  | { type: "organization.deleted"; data: { id: string } }
  | {
      type:
        | "organizationMembership.created"
        | "organizationMembership.updated";
      data: any;
    }
  | { type: "organizationMembership.deleted"; data: { id: string } }
  | { type: string; data: any }; // catch-all for unhandled types

const http = httpRouter();

http.route({
  path: "/clerk-webhook",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const secret = process.env.CLERK_WEBHOOK_SECRET;
    const issuerDomain = process.env.CLERK_JWT_ISSUER_DOMAIN;
    if (!secret || !issuerDomain) {
      console.error("Missing CLERK_WEBHOOK_SECRET or CLERK_JWT_ISSUER_DOMAIN");
      return new Response("Server misconfigured", { status: 500 });
    }

    const svixId = req.headers.get("svix-id");
    const svixTimestamp = req.headers.get("svix-timestamp");
    const svixSignature = req.headers.get("svix-signature");
    if (!svixId || !svixTimestamp || !svixSignature) {
      return new Response("Missing Svix headers", { status: 400 });
    }
    const body = await req.text();

    let event: ClerkEvent;
    try {
      event = new Webhook(secret).verify(body, {
        "svix-id": svixId,
        "svix-timestamp": svixTimestamp,
        "svix-signature": svixSignature,
      }) as ClerkEvent;
    } catch (err) {
      console.error("Svix verification failed:", err);
      return new Response("Invalid signature", { status: 400 });
    }

    switch (event.type) {
      case "user.created":
      case "user.updated":
        await ctx.runMutation(internal.clerkSync.upsertUser, {
          data: event.data,
          issuerDomain,
        });
        break;
      case "user.deleted":
        await ctx.runMutation(internal.clerkSync.deleteUser, {
          clerkUserId: event.data.id,
        });
        break;
      case "organization.created":
      case "organization.updated":
        await ctx.runMutation(internal.clerkSync.upsertOrganization, {
          data: event.data,
        });
        break;
      case "organization.deleted":
        await ctx.runMutation(internal.clerkSync.deleteOrganization, {
          clerkOrgId: event.data.id,
        });
        break;
      case "organizationMembership.created":
      case "organizationMembership.updated":
        await ctx.runMutation(internal.clerkSync.upsertMembership, {
          data: event.data,
          attempts: 0,
        });
        break;
      case "organizationMembership.deleted":
        await ctx.runMutation(internal.clerkSync.deleteMembership, {
          clerkMembershipId: event.data.id,
        });
        break;
      default:
        // Unhandled event type — log and 200 so Clerk doesn't retry forever.
        console.log("Unhandled Clerk event:", event.type);
    }

    return new Response("ok", { status: 200 });
  }),
});

export default http;
```

- [ ] **Step 4: Run tests to verify pass**

```bash
npm run test
```

Expected: all previous tests still passing, plus 3 new from `http.test.ts` → total test count matches.

- [ ] **Step 5: Commit**

```bash
git add convex/http.ts convex/http.test.ts
git commit -m "feat(convex): add Svix-verified Clerk webhook endpoint"
```

---

## Task 11: Public `ensureUser` mutation + `workspace` query

**Files:**
- Create: `slack-b2b-app/convex/users.ts`
- Create: `slack-b2b-app/convex/workspace.ts`
- Create: `slack-b2b-app/convex/workspace.test.ts`

- [ ] **Step 1: Create `convex/users.ts`**

Full file contents:

```typescript
import { mutation } from "./_generated/server";
import { ensureUser as ensureUserHelper } from "./auth";

/**
 * Called once by the client after sign-in to guarantee a Convex user row
 * exists before any other query or mutation runs. Idempotent.
 */
export const ensureUser = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await ensureUserHelper(ctx);
    return { _id: user._id, email: user.email, name: user.name };
  },
});
```

- [ ] **Step 2: Write failing tests for `workspace` module**

Full file `convex/workspace.test.ts`:

```typescript
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const TOKEN = "https://awaited-boxer-54.clerk.accounts.dev|user_abc";

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
});

test("getOverview returns org name + user name + role for a member", async () => {
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

test("getOverview throws for non-member", async () => {
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
    // Intentionally no membership row.
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
```

- [ ] **Step 3: Run tests to confirm they fail**

```bash
npm run test -- workspace
```

Expected: FAIL — `api.workspace.*` not defined.

- [ ] **Step 4: Create `convex/workspace.ts`**

Full file contents:

```typescript
import { v } from "convex/values";
import { query } from "./_generated/server";
import { assertMember, getAuthedUser } from "./auth";

/**
 * Minimal "who am I" — returns null if the caller has no Convex user row yet.
 * The UI uses this to decide whether to render a loading state vs content.
 */
export const whoami = query({
  args: {},
  handler: async (ctx) => {
    const user = await getAuthedUser(ctx);
    if (!user) return null;
    return { _id: user._id, email: user.email, name: user.name };
  },
});

/**
 * Workspace home page data: org name, user name, role. Throws if the caller
 * is not a member of `slug`.
 */
export const getOverview = query({
  args: { slug: v.string() },
  handler: async (ctx, { slug }) => {
    const user = await getAuthedUser(ctx);
    if (!user) throw new Error("Not authenticated");
    const { org, membership } = await assertMember(ctx, user._id, slug);
    return {
      orgName: org.name,
      orgSlug: org.slug,
      userName: user.name ?? user.email,
      role: membership.role,
    };
  },
});
```

- [ ] **Step 5: Run ALL tests to verify everything passes**

```bash
npm run test
```

Expected: 4 auth tests, 10 clerkSync tests, 3 http tests, 4 workspace tests — all green. Total: 21.

- [ ] **Step 6: Commit**

```bash
git add convex/users.ts convex/workspace.ts convex/workspace.test.ts
git commit -m "feat(convex): add public ensureUser mutation + workspace queries"
```

---

## Task 12: Register the webhook endpoint in Clerk Dashboard (user action)

**Files:** none modified.

- [ ] **Step 1: Deploy the webhook endpoint to Convex dev**

```bash
cd slack-b2b-app
npx convex dev --once
```

Confirm the output mentions `http.ts` being deployed. The endpoint is now live at `https://spotted-rook-538.convex.site/clerk-webhook`.

- [ ] **Step 2: Register the webhook in Clerk Dashboard**

Go to Clerk Dashboard → Webhooks → **Add Endpoint**. Fill in:

- **Endpoint URL:** `https://spotted-rook-538.convex.site/clerk-webhook`
- **Message filtering — subscribe to:**
  - `user.created`
  - `user.updated`
  - `user.deleted`
  - `organization.created`
  - `organization.updated`
  - `organization.deleted`
  - `organizationMembership.created`
  - `organizationMembership.updated`
  - `organizationMembership.deleted`

Click **Create**. Clerk shows a **Signing Secret** starting with `whsec_`. Copy it.

- [ ] **Step 3: Set `CLERK_WEBHOOK_SECRET` on Convex Dashboard**

Convex Dashboard → Settings → Environment Variables → **Add**:

- **Name:** `CLERK_WEBHOOK_SECRET`
- **Value:** the `whsec_...` from Step 2

Save. Confirm the variable now appears alongside `CLERK_JWT_ISSUER_DOMAIN`.

- [ ] **Step 4: Smoke test the webhook via Clerk's "Send Example" button**

In the Clerk Webhooks UI, click the endpoint → **Testing** tab → send an example `user.created` event. Expected: Clerk shows **200 OK** response. If 400/500, inspect Convex logs (`npx convex logs` or dashboard → Logs).

- [ ] **Step 5: Verify the row landed in Convex**

Convex Dashboard → Data → `users` table. Expected: one row with the example user data from Clerk's test payload. If present, the webhook pipe is end-to-end live. (Delete the row via the dashboard once verified, so the local data is clean.)

- [ ] **Step 6: Confirm in chat**

Nothing to commit. Report back: "Webhook live, smoke test green, test row deleted."

---

## Task 13: Base layout — `<ClerkProvider appearance>` + `<SyncUser />`

**Files:**
- Modify: `slack-b2b-app/app/layout.tsx`
- Create: `slack-b2b-app/components/SyncUser.tsx`

- [ ] **Step 1: Create `components/SyncUser.tsx`**

Full file contents:

```tsx
"use client";

import { useEffect } from "react";
import { useMutation } from "convex/react";
import { useAuth } from "@clerk/nextjs";
import { api } from "@/convex/_generated/api";

/**
 * Mounted in the root layout. When the user signs in, calls the idempotent
 * `users.ensureUser` mutation once to guarantee a Convex user row exists
 * before any tenant-scoped query runs.
 */
export function SyncUser() {
  const { isSignedIn, isLoaded } = useAuth();
  const ensureUser = useMutation(api.users.ensureUser);

  useEffect(() => {
    if (!isLoaded || !isSignedIn) return;
    void ensureUser();
  }, [isLoaded, isSignedIn, ensureUser]);

  return null;
}
```

- [ ] **Step 2: Replace `app/layout.tsx`**

Full file contents:

```tsx
import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import ConvexClientProvider from "@/components/ConvexClientProvider";
import { SyncUser } from "@/components/SyncUser";
import { ClerkProvider } from "@clerk/nextjs";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Slack B2B",
  description: "Multi-tenant team chat",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <ClerkProvider
      dynamic
      appearance={{
        variables: {
          colorPrimary: "#4A154B", // Slack aubergine — swap later
        },
      }}
    >
      <ConvexClientProvider>
        <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
          <body className="min-h-full flex flex-col">
            <SyncUser />
            {children}
          </body>
        </html>
      </ConvexClientProvider>
    </ClerkProvider>
  );
}
```

- [ ] **Step 3: Verify the build still succeeds**

```bash
cd slack-b2b-app
npm run build
```

Expected: build passes. If you get a hydration warning about `<ClerkProvider>` outside `<html>`, swap the nesting order to `<html><body><ClerkProvider>...</ClerkProvider></body></html>`.

- [ ] **Step 4: Commit**

```bash
git add app/layout.tsx components/SyncUser.tsx
git commit -m "feat: wire ClerkProvider with appearance + SyncUser in root layout"
```

---

## Task 14: Landing page `/`

**Files:**
- Modify: `slack-b2b-app/app/page.tsx` (already set in Task 3; verify and refine)

- [ ] **Step 1: Verify `app/page.tsx` matches the intended contents**

Open the file. If it doesn't match the snippet from Task 3 Step 2, replace it now:

```tsx
import Link from "next/link";
import { SignedIn, SignedOut, SignInButton, SignUpButton } from "@clerk/nextjs";

export default function Home() {
  return (
    <main className="flex flex-col flex-1 items-center justify-center gap-6 p-8">
      <h1 className="text-4xl font-bold">Slack B2B</h1>
      <p className="text-zinc-500">A multi-tenant team chat app.</p>
      <SignedOut>
        <div className="flex gap-3">
          <SignInButton mode="modal">
            <button className="rounded-md bg-foreground px-4 py-2 text-background">
              Sign in
            </button>
          </SignInButton>
          <SignUpButton mode="modal">
            <button className="rounded-md border px-4 py-2">Sign up</button>
          </SignUpButton>
        </div>
      </SignedOut>
      <SignedIn>
        <Link href="/create-workspace" className="underline">
          Go to your workspace
        </Link>
      </SignedIn>
    </main>
  );
}
```

- [ ] **Step 2: Skip commit if unchanged, else:**

```bash
git add app/page.tsx
git commit -m "feat: landing page with signed-in/signed-out branches"
```

---

## Task 15: Sign-in + sign-up routes

**Files:**
- Create: `slack-b2b-app/app/sign-in/[[...sign-in]]/page.tsx`
- Create: `slack-b2b-app/app/sign-up/[[...sign-up]]/page.tsx`

- [ ] **Step 1: Create `app/sign-in/[[...sign-in]]/page.tsx`**

```tsx
import { SignIn } from "@clerk/nextjs";

export default function Page() {
  return (
    <main className="flex flex-1 items-center justify-center p-8">
      <SignIn
        signUpUrl="/sign-up"
        forceRedirectUrl="/create-workspace"
      />
    </main>
  );
}
```

- [ ] **Step 2: Create `app/sign-up/[[...sign-up]]/page.tsx`**

```tsx
import { SignUp } from "@clerk/nextjs";

export default function Page() {
  return (
    <main className="flex flex-1 items-center justify-center p-8">
      <SignUp
        signInUrl="/sign-in"
        forceRedirectUrl="/create-workspace"
      />
    </main>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add app/sign-in app/sign-up
git commit -m "feat: add /sign-in and /sign-up routes with Clerk components"
```

---

## Task 16: Create-workspace route

**Files:**
- Create: `slack-b2b-app/app/create-workspace/page.tsx`

- [ ] **Step 1: Create the file**

```tsx
import { CreateOrganization } from "@clerk/nextjs";

export default function Page() {
  return (
    <main className="flex flex-1 items-center justify-center p-8">
      <div className="flex flex-col gap-4 items-center">
        <h1 className="text-2xl font-semibold">Create your workspace</h1>
        <p className="text-zinc-500 text-sm max-w-sm text-center">
          This will be the home for your team. You can invite teammates by email
          once the workspace is created.
        </p>
        <CreateOrganization
          afterCreateOrganizationUrl="/:slug"
          skipInvitationScreen={false}
        />
      </div>
    </main>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add app/create-workspace
git commit -m "feat: add /create-workspace route"
```

---

## Task 17: Update `proxy.ts` routing logic

**Files:**
- Modify: `slack-b2b-app/proxy.ts`

- [ ] **Step 1: Replace the file contents**

```typescript
import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

const isPublic = createRouteMatcher(["/", "/sign-in(.*)", "/sign-up(.*)"]);
const isCreateWorkspace = createRouteMatcher(["/create-workspace"]);

export default clerkMiddleware(async (auth, req) => {
  if (isPublic(req)) return;

  const { orgSlug } = await auth.protect();

  // Signed in, visiting /create-workspace with an active org → go to workspace.
  if (isCreateWorkspace(req) && orgSlug) {
    return NextResponse.redirect(new URL(`/${orgSlug}`, req.url));
  }

  // Signed in, visiting a workspace-scoped route with no active org → force creation.
  if (!isCreateWorkspace(req) && !orgSlug) {
    return NextResponse.redirect(new URL("/create-workspace", req.url));
  }

  // URL slug must match active org. If not, redirect to their active org.
  const urlSlug = req.nextUrl.pathname.split("/")[1];
  if (urlSlug && orgSlug && urlSlug !== orgSlug && !isCreateWorkspace(req)) {
    return NextResponse.redirect(new URL(`/${orgSlug}`, req.url));
  }
});

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
```

- [ ] **Step 2: Smoke test middleware by starting the dev server**

```bash
cd slack-b2b-app
npm run dev
```

Visit `http://localhost:3000/somerandompath` while signed out. Expected: redirect to Clerk sign-in. Stop the dev server (Ctrl-C).

- [ ] **Step 3: Commit**

```bash
git add proxy.ts
git commit -m "feat: proxy.ts routes unauthenticated users to sign-in and enforces slug/org match"
```

---

## Task 18: `/[slug]` layout with `<SyncActiveOrg />`

**Files:**
- Create: `slack-b2b-app/components/SyncActiveOrg.tsx`
- Create: `slack-b2b-app/app/[slug]/layout.tsx`

- [ ] **Step 1: Create `components/SyncActiveOrg.tsx`**

```tsx
"use client";

import { useEffect } from "react";
import { useOrganizationList, useOrganization } from "@clerk/nextjs";

/**
 * Keeps the Clerk "active organization" in lock-step with the URL slug.
 *
 * - User navigates to /beta while /acme is active → flip the active org to beta.
 * - If the user is not a member of /beta, Clerk throws and the proxy has already
 *   redirected them — so in practice this only runs on valid slugs.
 */
export function SyncActiveOrg({ slug }: { slug: string }) {
  const { organization } = useOrganization();
  const { setActive, userMemberships, isLoaded } = useOrganizationList({
    userMemberships: { infinite: false },
  });

  useEffect(() => {
    if (!isLoaded) return;
    if (organization?.slug === slug) return;
    const match = userMemberships.data?.find(
      (m) => m.organization.slug === slug,
    );
    if (!match) return; // proxy will redirect this request; nothing to do here.
    void setActive({ organization: match.organization.id });
  }, [isLoaded, organization?.slug, slug, userMemberships.data, setActive]);

  return null;
}
```

- [ ] **Step 2: Create `app/[slug]/layout.tsx`**

```tsx
import { SyncActiveOrg } from "@/components/SyncActiveOrg";

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
      {children}
    </>
  );
}
```

(Note: Next 16 `params` is a Promise; always `await` it in layouts and pages.)

- [ ] **Step 3: Commit**

```bash
git add app/[slug]/layout.tsx components/SyncActiveOrg.tsx
git commit -m "feat: /[slug] layout syncs Clerk active org with URL slug"
```

---

## Task 19: `/[slug]` workspace home page

**Files:**
- Create: `slack-b2b-app/app/[slug]/page.tsx`

- [ ] **Step 1: Create the file**

```tsx
"use client";

import Link from "next/link";
import { use } from "react";
import { useQuery } from "convex/react";
import { OrganizationSwitcher, UserButton } from "@clerk/nextjs";
import { api } from "@/convex/_generated/api";

export default function WorkspaceHome({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = use(params);
  const overview = useQuery(api.workspace.getOverview, { slug });

  return (
    <div className="flex flex-col flex-1">
      <header className="flex items-center justify-between border-b px-6 py-3">
        <div className="flex items-center gap-3">
          <OrganizationSwitcher
            afterSelectOrganizationUrl="/:slug"
            afterCreateOrganizationUrl="/:slug"
            hidePersonal
          />
        </div>
        <div className="flex items-center gap-3">
          <Link href={`/${slug}/members`} className="text-sm underline">
            Manage members
          </Link>
          <UserButton />
        </div>
      </header>
      <main className="flex-1 flex flex-col items-center justify-center gap-3 p-8">
        {overview === undefined ? (
          <p className="text-zinc-500">Loading workspace…</p>
        ) : (
          <>
            <h1 className="text-3xl font-bold">Welcome, {overview.userName}</h1>
            <p className="text-zinc-600">
              You&apos;re {overview.role === "org:admin" ? "an admin" : "a member"} of{" "}
              <span className="font-medium">{overview.orgName}</span>.
            </p>
          </>
        )}
      </main>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add app/[slug]/page.tsx
git commit -m "feat: /[slug] workspace home shows org name, user name, role"
```

---

## Task 20: `/[slug]/members` page

**Files:**
- Create: `slack-b2b-app/app/[slug]/members/page.tsx`

- [ ] **Step 1: Create the file**

```tsx
import { OrganizationProfile } from "@clerk/nextjs";

export default function MembersPage() {
  return (
    <main className="flex flex-1 items-start justify-center p-8">
      <OrganizationProfile routing="hash" />
    </main>
  );
}
```

(Clerk enforces admin-only visibility for invite actions inside `<OrganizationProfile />` — no extra guard needed.)

- [ ] **Step 2: Commit**

```bash
git add app/[slug]/members
git commit -m "feat: /[slug]/members page uses OrganizationProfile"
```

---

## Task 21: Manual end-to-end verification (acceptance criteria)

**Files:** none.

This runs the 10 acceptance steps from the spec. No automation; a human executes these against dev Clerk + dev Convex.

- [ ] **Step 1: Start both servers**

```bash
cd slack-b2b-app
npm run dev
```

Wait until both Next.js and Convex are up.

- [ ] **Step 2: Run the acceptance checklist**

In a browser (ideally a fresh profile with no prior Clerk sessions):

- [ ] Visit `http://localhost:3000/`, click Sign Up, create an account via Email (or Google / GitHub).
- [ ] Land on `/create-workspace`, create a workspace called "Acme".
- [ ] Land on `/acme` and see "Welcome {your name} — you're an admin of Acme."
- [ ] Click "Manage members", invite a second email you control (e.g. a `+alias`).
- [ ] In an incognito window, open the invitation email, click the link, sign up, land on `/acme`, see "Welcome {name2} — you're a member of Acme."
- [ ] Open Convex Dashboard → Data → confirm `users` has 2 rows, `organizations` has 1 row, `memberships` has 2 rows, all with matching `clerkUserId` / `clerkOrgId` / `clerkMembershipId`.
- [ ] In incognito, click `<OrganizationSwitcher />` → "Create organization" → make "Beta". URL changes to `/beta`. Switch back to `/acme`, URL + active org stay in sync.
- [ ] In the main window, rename the workspace in Clerk (OrganizationSwitcher → Organization settings → rename to "Acme Corp"). Within a second, `/acme-corp` shows the updated name reactively.
- [ ] In the main window, remove the second user from Acme. In the incognito window, refresh `/acme-corp` — query throws "Not a member" (UI shows an error).
- [ ] In the main window, navigate directly to `/unknown-slug`. Expected: redirect to your active workspace (`/acme-corp`).

- [ ] **Step 3: If any step fails, diagnose**

- Webhook 4xx → check `CLERK_WEBHOOK_SECRET` on Convex matches Clerk.
- `ctx.auth.getUserIdentity()` is null → check `CLERK_JWT_ISSUER_DOMAIN` on Convex matches the JWT template's issuer.
- "Not a member" when it should work → compare `memberships` table rows against the membership in Clerk's Organizations tab.
- Infinite redirect loop → inspect `proxy.ts` conditions; the typical cause is `urlSlug === "create-workspace"` matching the first branch.

- [ ] **Step 4: Run the full automated test suite one last time**

```bash
npm run test
```

Expected: all tests pass.

- [ ] **Step 5: Final commit (if any diagnostic fixes were needed)**

```bash
git add -A
git commit -m "fix: E2E diagnostics from Foundation acceptance run"
```

(If nothing was fixed, skip.)

- [ ] **Step 6: Tag Foundation as shipped**

```bash
git tag -a foundation-v1 -m "Foundation milestone: auth + tenancy + Clerk↔Convex sync"
```

**Foundation is done.** Next milestone: Billing — add Clerk Billing, attach Free/Pro plans to organizations, gate Convex queries on entitlements.

---

## Spec ↔ plan coverage check

| Spec section | Covered by task(s) |
|---|---|
| Decisions table | All tasks as a whole; each decision is implemented somewhere |
| Scope / non-goals | Plan avoids non-goals by construction |
| Architecture & data flow | Tasks 5–11, 13, 17, 18 |
| Convex schema | Task 3 |
| Routes & middleware | Tasks 14–17 |
| Clerk ↔ Convex sync (JIT) | Tasks 5, 6, 11, 13 |
| Clerk ↔ Convex sync (webhooks) | Tasks 7–10, 12 |
| UI screens | Tasks 13–16, 18–20 |
| Acceptance criteria | Task 21 |
| Testing | Tasks 5–11 (unit) + Task 21 (manual E2E) |
| Pre-implementation setup | Tasks 0, 4, 12 |
| Open risks — Next 16 / Clerk 6.x compat | Task 1 |
| Open risks — out-of-order webhooks retry | Task 9 |
| Open risks — leaked dev secrets | Noted in spec; rotate opportunistically |
| Open risks — reserved slug collisions | Deferred — low likelihood for Foundation; tracked in spec |
