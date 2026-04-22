# Foundation — Auth, Tenancy & Clerk↔Convex Sync

**Date:** 2026-04-22
**Status:** Draft, awaiting user review
**Milestone:** 1 of 6 (Foundation → Billing → Messaging core → Messaging polish → File uploads → Admin UX)

## Summary

Ship an end-to-end auth + tenancy + data-sync pipeline for a B2B multi-tenant SaaS. Clerk owns identity and organizations; Convex mirrors users, organizations, and memberships so app data can foreign-key against them. After Foundation, a user can sign up, create or be invited into a workspace, land at `/[slug]`, see their name and role, invite teammates by email, and switch between workspaces. Every Convex query and mutation authenticates the caller and scopes to their current workspace.

No messaging, no billing, no file uploads. Those are later milestones built on top of this.

## Decisions (captured during brainstorming)

| # | Decision | Choice |
|---|---|---|
| 1 | Clerk Org ↔ workspace mapping | **1 Clerk Org = 1 workspace** (1:1) |
| 2 | Sign-up flow | **Force org on sign-up**; a user can belong to **many** workspaces |
| 3 | URL structure | **`/[slug]/...`** (path-based multi-tenancy) |
| 4 | Roles | **Clerk defaults only**: `org:admin`, `org:member` |
| 5 | Invite flow | **Clerk built-in email invitations** via `<OrganizationProfile />` |
| 6 | Sign-in methods | **Email (password), Google OAuth, GitHub OAuth** |
| 7 | Clerk→Convex sync | **JIT + webhooks** (both) |
| 8 | UI approach | **Clerk prebuilt components** (`<SignIn />`, `<SignUp />`, `<CreateOrganization />`, `<OrganizationSwitcher />`, `<OrganizationProfile />`, `<UserButton />`) |

## Scope & non-goals

### In scope

- Sign-up / sign-in via Email, Google, GitHub.
- Force a new user to create or join a workspace before they see the app.
- Path-based tenancy: `/[slug]` is the workspace home; middleware keeps URL slug and Clerk active org in sync.
- Clerk webhooks populate Convex `users`, `organizations`, `memberships`; a JIT helper guarantees a user row exists the moment a user authenticates.
- Workspace home showing the signed-in user's name, role, and workspace name.
- Admin-only member management page at `/[slug]/members` using `<OrganizationProfile />`.
- Workspace switcher (`<OrganizationSwitcher />`) that updates the URL when the user switches.
- Role-aware access checks in every Convex query/mutation via an `assertMember(ctx, userId, slug)` helper.

### Explicitly out of scope (deferred to later milestones)

- Billing, plans, Pro/Free gating (milestone 2).
- Any messaging primitive: channels, messages, DMs, threads, reactions, typing indicators, unread counts (milestones 3–4).
- File uploads / Convex file storage (milestone 5).
- Shareable invite links (distinct from Clerk email invitations).
- Custom roles beyond `org:admin` and `org:member`; guest accounts.
- Workspace deletion, leaving a workspace, ownership transfer.
- Custom-branded auth UI beyond Clerk's `appearance` prop.
- Dark mode, i18n, accessibility audit, observability beyond Convex's built-in.

## Architecture & data flow

Three actors, three pipes between them.

```
                       ┌─────────────────────┐
          (1) Session  │                     │
  ┌────────cookie──────┤   Clerk (SaaS)      │
  │                    │   - Users           │
  │                    │   - Organizations   │
  │                    │   - Memberships     │
  │                    │   - Invitations     │
  │                    └──────────┬──────────┘
  │                               │ (3) Webhook POST
  │                               │     (user.*, organization.*,
  ▼                               │      organizationMembership.*)
┌──────────────────────┐          ▼
│                      │    ┌──────────────────────┐
│  Next.js 16          │    │                      │
│  app router          │    │  Convex              │
│  + proxy.ts          │───▶│  - users             │
│    (Clerk middleware)│    │  - organizations     │
│                      │    │  - memberships       │
│  ClerkProvider       │    │  - auth.config.ts    │
│  ConvexProviderWith  │(2) │  - http.ts (webhook) │
│    Clerk             │JWT │                      │
└──────────────────────┘    └──────────────────────┘
```

1. **Browser session (Clerk-managed).** Clerk sets a session cookie. `proxy.ts` reads it via `clerkMiddleware()` on every request and protects tenant-scoped routes.
2. **JWT tokens (per-request, Clerk → Convex).** `ConvexProviderWithClerk` attaches a JWT from Clerk's `convex` template to every Convex call. Convex's `auth.config.ts` declares the Clerk issuer and validates the JWT. `ctx.auth.getUserIdentity()` returns identity inside queries/mutations.
3. **Webhooks (event-driven, Clerk → Convex).** A Convex HTTP action at `https://spotted-rook-538.convex.site/clerk-webhook` receives signed events, verifies Svix signatures using `CLERK_WEBHOOK_SECRET`, and writes to the mirrored tables.

### Request flow — page load at `/acme/home`

1. Browser requests `/acme/home`.
2. `proxy.ts` runs. `auth.protect()` rejects if no Clerk session.
3. React renders. `ConvexProviderWithClerk` fetches a JWT from Clerk.
4. Convex query runs. Line 1: `getAuthedUser(ctx)` / `ensureUser(ctx)`. Line 2: `assertMember(ctx, user._id, slug)` — throws if not a member.
5. Query returns scoped data, or a thrown error surfaces a "no access" UI.

### Why JWT **and** webhooks

JWT answers *who is calling right now*. Webhooks answer *what changed in Clerk since the last call*. Together they close the race window on first sign-in (JIT fills the gap before the webhook arrives) and catch server-side changes the user didn't trigger (profile edits, admin-driven membership changes, deletions).

## Convex schema

Three tables. All mirror Clerk-owned data; Clerk is the source of truth, these are the local index Convex needs to foreign-key against.

```typescript
// convex/schema.ts
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  users: defineTable({
    clerkUserId: v.string(),        // "user_2abc..."
    tokenIdentifier: v.string(),    // "<issuer>|<clerkUserId>" — what ctx.auth returns
    email: v.string(),
    name: v.optional(v.string()),
    imageUrl: v.optional(v.string()),
  })
    .index("by_clerk_user_id", ["clerkUserId"])
    .index("by_token_identifier", ["tokenIdentifier"]),

  organizations: defineTable({
    clerkOrgId: v.string(),         // "org_2xyz..."
    slug: v.string(),               // URL slug; Clerk generates + admins edit
    name: v.string(),
    imageUrl: v.optional(v.string()),
  })
    .index("by_clerk_org_id", ["clerkOrgId"])
    .index("by_slug", ["slug"]),

  memberships: defineTable({
    userId: v.id("users"),
    organizationId: v.id("organizations"),
    clerkMembershipId: v.string(),  // "orgmem_..." — so delete webhooks can find the row
    role: v.string(),               // "org:admin" | "org:member" — Clerk's string format
  })
    .index("by_user", ["userId"])
    .index("by_organization", ["organizationId"])
    .index("by_user_and_organization", ["userId", "organizationId"])
    .index("by_clerk_membership_id", ["clerkMembershipId"]),
});
```

### Design notes

- **Two IDs per user.** Webhooks give us `user_xxx`; `ctx.auth.getUserIdentity()` gives us `tokenIdentifier` (`${issuer}|${subject}`). Storing both — with an index each — lets each code path look up by the ID it naturally holds.
- **`slug` lives on Convex, sourced from Clerk.** Clerk generates and lets admins edit slugs. Webhooks keep it current. `by_slug` powers URL → org lookups.
- **`role` is `v.string()`, not a literal union.** Clerk allows custom roles in the dashboard. Locking to the two current values would force a schema migration the moment we add a custom role. Handlers validate known values explicitly.
- **`clerkMembershipId` on the membership row.** `organizationMembership.deleted` only carries the membership ID; this index avoids a scan.
- **No DB-level uniqueness.** Convex doesn't enforce uniqueness; handlers are check-then-insert so duplicates cannot happen in practice.
- **No `createdAt` / `updatedAt`.** `_creationTime` is automatic. Add `updatedAt` later if audit requires it.

## Routes & middleware

| Route | Auth | Who renders | Purpose |
|---|---|---|---|
| `/` | public | custom page | Landing: headline + sign-in / sign-up CTAs; redirects signed-in users to their active workspace |
| `/sign-in/[[...sign-in]]` | public | `<SignIn />` | Catch-all so Clerk owns its URLs |
| `/sign-up/[[...sign-up]]` | public | `<SignUp />` | Catch-all |
| `/create-workspace` | authed, no active org | `<CreateOrganization />` | Forced landing for users with zero memberships |
| `/[slug]` | authed, member | custom page | Workspace home — the "proof it works" screen |
| `/[slug]/members` | authed, admin | `<OrganizationProfile />` | Members + invitations; Clerk enforces admin-only |

The webhook endpoint is on Convex, not Next.js: `https://spotted-rook-538.convex.site/clerk-webhook`.

### `proxy.ts`

Next 16 renamed `middleware.ts` to `proxy.ts`. The `edge` runtime is not supported; `proxy` runs in Node.

```typescript
import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

const isPublic = createRouteMatcher(["/", "/sign-in(.*)", "/sign-up(.*)"]);
const isCreateWorkspace = createRouteMatcher(["/create-workspace"]);

export default clerkMiddleware(async (auth, req) => {
  if (isPublic(req)) return;

  const { orgSlug } = await auth.protect(); // 401 if not signed in

  if (isCreateWorkspace(req) && orgSlug) {
    return NextResponse.redirect(new URL(`/${orgSlug}`, req.url));
  }
  if (!isCreateWorkspace(req) && !orgSlug) {
    return NextResponse.redirect(new URL("/create-workspace", req.url));
  }

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

### Active-org / URL-slug sync

- **Switcher → URL.** `<OrganizationSwitcher afterSelectOrganizationUrl="/:slug" />` navigates when the user switches in the UI.
- **URL → switcher.** A `<SyncActiveOrg />` client component in `app/[slug]/layout.tsx` calls `setActive({ organization })` when the URL slug doesn't match the current active org (e.g. user pastes a link).
- **Mismatch.** `proxy.ts` catches the case where a user navigates to a `[slug]` they're not in and redirects them to their active workspace.

## Clerk ↔ Convex sync

### JIT helpers (`convex/auth.ts`)

```typescript
// Ensure (insert-if-missing) — called from mutations.
export async function ensureUser(ctx: MutationCtx): Promise<Doc<"users">>

// Read-only variant — called from queries. Returns null if the JIT row isn't there yet.
export async function getAuthedUser(ctx: QueryCtx): Promise<Doc<"users"> | null>

// Scope + authorize to a workspace.
export async function assertMember(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
  slug: string,
): Promise<{ org: Doc<"organizations">; membership: Doc<"memberships"> }>
```

Usage pattern at the top of every tenant-scoped Convex function:

```typescript
const user = await ensureUser(ctx);                           // or getAuthedUser in queries
const { org, membership } = await assertMember(ctx, user._id, args.slug);
// now safe to do scoped work
```

`ensureUser` is also exposed as a public mutation (`api.users.ensureUser`) and called once from a `<SyncUser />` client component mounted inside the authed layout, so the row exists before the user triggers any other interaction.

### Webhook handler (`convex/http.ts`)

Shape:

```typescript
http.route({
  path: "/clerk-webhook",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    // 1. Verify Svix signature using CLERK_WEBHOOK_SECRET. Reject 400 on fail.
    //    (Return 5xx only for transient failures — Clerk retries those; 4xx is terminal.)
    // 2. Switch on event.type → route to an internal mutation.
    // 3. Return 200 on success.
  }),
});
```

| Clerk event | Internal mutation | Behavior |
|---|---|---|
| `user.created` / `user.updated` | `upsertUser` | Find by `clerkUserId`, patch or insert |
| `user.deleted` | `deleteUser` | Delete the user row AND cascade-delete its memberships |
| `organization.created` / `organization.updated` | `upsertOrganization` | Find by `clerkOrgId`, patch (incl. `slug` when admin renames) or insert |
| `organization.deleted` | `deleteOrganization` | Delete the org row AND cascade-delete its memberships |
| `organizationMembership.created` / `organizationMembership.updated` | `upsertMembership` | Find by `clerkMembershipId`, patch `role` or insert |
| `organizationMembership.deleted` | `deleteMembership` | Delete the membership row |

**Idempotency.** Every handler is check-then-patch/insert. Svix retries cannot produce duplicates.

**Out-of-order webhooks.** If `organizationMembership.created` arrives before its `organization.created`, the membership handler queues a retry via `ctx.scheduler.runAfter(5000, ...)`. Retries are bounded: the scheduled mutation carries an `attempts` counter and gives up after 5 attempts, logging the dropped event for manual inspection.

**Large cascades.** `user.deleted` / `organization.deleted` use `.take(n)` + `ctx.scheduler.runAfter(0, ...)` to process memberships in batches if the set is big enough to exceed Convex's per-mutation document limit.

## UI screens

All Clerk prebuilt components, mounted with minimal wrapping. Brand styling via a single `<ClerkProvider appearance={...}>` in `app/layout.tsx`.

| Route | Component | Key props |
|---|---|---|
| `/sign-in/[[...sign-in]]` | `<SignIn />` | `signUpUrl="/sign-up"`, `forceRedirectUrl="/create-workspace"` |
| `/sign-up/[[...sign-up]]` | `<SignUp />` | `forceRedirectUrl="/create-workspace"` |
| `/create-workspace` | `<CreateOrganization />` | `afterCreateOrganizationUrl="/:slug"` |
| `/[slug]` | custom | renders workspace name + user name + role + `<OrganizationSwitcher afterSelectOrganizationUrl="/:slug" />` + `<UserButton />` + link to `/[slug]/members`; data from `api.workspace.getOverview({ slug })` |
| `/[slug]/members` | `<OrganizationProfile />` | defaults; Clerk enforces admin-only visibility for invite actions |

## Acceptance criteria

Foundation is done when a second person can complete all ten steps end-to-end, unaided, on development Convex + Clerk:

1. Visit `/`, click Sign Up, create an account via Email, Google, or GitHub.
2. Land on `/create-workspace`, create a workspace called "Acme".
3. Land on `/acme` and see: "Welcome Jane — you're an admin of Acme."
4. Click "Manage members", invite `bob@example.com`.
5. Bob receives the email, clicks the link, signs up, lands on `/acme` and sees: "Welcome Bob — you're a member of Acme."
6. Jane opens Convex dashboard → Data tab → confirms `users` has 2 rows, `organizations` has 1 row, `memberships` has 2 rows, all with matching Clerk IDs.
7. Bob creates his own workspace "Beta" via `<OrganizationSwitcher />` → "Create organization". URL changes to `/beta`. Switcher lists both. Switching back to `/acme` works; URL + active org stay in sync.
8. Jane renames the workspace to "Acme Corp" in Clerk's org profile → `organization.updated` webhook fires → Convex `organizations.name` updates → UI reflects the change reactively within a second.
9. Jane removes Bob from Acme → `organizationMembership.deleted` webhook fires → Bob's next query on `/acme` throws "Not a member" → UI shows a no-access screen.
10. Navigating to `/some-unknown-slug` (where the user isn't a member) redirects to the user's active workspace.

Any failing step means Foundation is not done.

## Testing

Three layers, each narrow.

1. **Convex function tests** — `convex-test` + `vitest` with `environment: "edge-runtime"`. One file per module: `users.test.ts`, `clerkSync.test.ts`, `workspace.test.ts`. Mock identity via `.withIdentity()`. Assert: `ensureUser` inserts on miss, returns existing on hit; `assertMember` throws on non-member; webhook handlers are idempotent (run twice → one row, not two).
2. **Webhook signature test** — valid Svix signature → 200; missing signature → 400; tampered body → 400.
3. **Manual E2E** — the 10 acceptance steps above, run by a human against dev Clerk + dev Convex. No Playwright in Foundation; added in the Messaging milestone.

Not tested: Clerk's prebuilt components (not our code), React-rendering of those components (same reason).

## Pre-implementation one-time setup

Before writing code:

1. **Clerk Dashboard → User & Authentication** — confirm Email, Google, GitHub enabled. *(done)*
2. **Clerk Dashboard → Organizations** — enable Organizations; allow any user to create; keep default `org:admin` + `org:member`.
3. **Clerk Dashboard → JWT Templates → "convex"** — verify. *(done)*
4. **Convex env var** — rename `ISSUER` → `CLERK_JWT_ISSUER_DOMAIN`.
5. **Convex `auth.config.ts`** — uncomment provider, reference `process.env.CLERK_JWT_ISSUER_DOMAIN`.
6. **Clerk Dashboard → Webhooks** — create endpoint `https://spotted-rook-538.convex.site/clerk-webhook`; subscribe to `user.*`, `organization.*`, `organizationMembership.*`; copy the signing secret.
7. **Convex env var** — set `CLERK_WEBHOOK_SECRET` from step 6.
8. **Repo consolidation** — delete the stale outer `c:/dev/b2bslack/` skeleton (outer `app/`, outer `package.json`, outer `.env`) and promote `slack-b2b-app/` contents up to the repo root. Confirm `.env.local` and `.env` do not land in git.

## Open risks

1. **Next 16 `proxy.ts` runtime vs Clerk 6.39.1.** Next 16 dropped edge-runtime support in `proxy.ts`; Clerk's `clerkMiddleware` was originally built for edge. First implementation step is to verify `@clerk/nextjs@6.39.1`'s `clerkMiddleware` runs cleanly in Next 16's Node-only `proxy.ts`. If it does not, two mitigations: bump to `@clerk/nextjs@7.x` (contingent on `convex/react-clerk`'s 7.x compatibility), or pin a 6.x version known to support Next 16. We verify before writing any other code.
2. **Convex + Clerk major version compatibility.** The outer repo uses `@clerk/nextjs@7.2.3`; the inner uses `@clerk/nextjs@6.39.1` + `@clerk/clerk-react@5.61.3` + `convex@1.35.1`. The inner versions are what pair with `convex/react-clerk` today. Any upgrade of Clerk must be validated against `convex/react-clerk` first.
3. **Webhook ordering.** Addressed by retry-on-missing-parent. No real-world instability expected, but the scheduler-based retry is load-bearing for correctness.
4. **Leaked dev secrets.** `CLERK_SECRET_KEY` from `.env` was shared during brainstorming. Rotate in the Clerk dashboard before going further.
5. **Reserved slug collisions.** An org slug like `sign-in`, `sign-up`, or `create-workspace` would route-collide with the public Next.js routes and the force-org flow. Mitigation: the `<CreateOrganization />` component validates slugs, but Clerk does not reserve our app-specific names. We'll add a disallow-list check via a Convex mutation that runs on `organization.created` webhooks and, if the slug collides, calls the Clerk Backend API to rename it (e.g. `acme` → `acme-1`). Logged as TODO for implementation; reserved list: `sign-in`, `sign-up`, `create-workspace` — and anything we add to the public-routes matcher later.
