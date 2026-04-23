# Billing Plans — Free + Pro (Clerk Billing)

**Date:** 2026-04-23
**Status:** Draft, awaiting user review
**Milestone:** 4 of 6 (Foundation → Messaging core → **Billing plans** → Messaging polish → File uploads → Admin UX)
**Depends on:** [Foundation](2026-04-22-foundation-design.md), [Messaging core](2026-04-22-messaging-core-design.md)

## Summary

Ship a two-tier subscription model on top of Messaging core using Clerk Billing (Organization plans). Free workspaces get public channels + 10,000-message history per channel. Pro workspaces get private channels + unlimited history. Admins manage the subscription from a new `/[slug]/settings/billing` page that hosts Clerk's `<PricingTable />`. All feature gates read plan state from the Clerk session JWT — no Convex mirror, no billing webhooks, no new tables.

## Decisions (captured during brainstorming)

| # | Decision | Choice |
|---|---|---|
| 1 | How do Convex functions read plan state? | **Clerk JWT.** `ctx.auth.getUserIdentity()` returns claims including `org_plan` and `org_features`. Small helper `assertFeature()` throws `PaywallError` when absent. Accepts ~60s JWT-refresh lag on subscription changes. |
| 2 | Plans | **`free_org`** (no fee) and **`pro`** ($14.99/mo or $119.88/yr, 3-day trial). Organization-level plans. Key asymmetry (`free_org` vs `pro`) accepted as-is. |
| 3 | Features per plan | **Free:** `public_channels`, `basic_messaging`. **Pro:** all of Free plus `private_channels`, `unlimited_message_history`. |
| 4 | What does "private" mean? | **Slack-style invite-only.** New `isPrivate: boolean` on `channels`. Hidden from browse. Any existing member can invite; no free-join path. |
| 5 | Free history behavior | **Rolling last 10,000 messages per channel.** Older messages stay in DB but aren't returned by `messages.list`. On reaching cap, client renders a single "Upgrade" CTA card at the top of the list. |
| 6 | Pro → Free downgrade | **No data destruction.** Existing private channels remain visible + usable by existing members; creating new private channels or new invites is blocked. Older messages past 10k are hidden at read time; re-upgrade restores visibility. |
| 7 | Billing UI placement | **Dedicated route** `/[slug]/settings/billing` with Clerk's `<PricingTable />`. Admin-only (non-admins redirected). Small "⚡ Upgrade to Pro" pill in sidebar on Free workspaces. |
| 8 | Webhooks for subscription lifecycle | **None.** JWT is authoritative; Clerk's Stripe flow handles checkout end-to-end. If we later need audit logs we can add a `subscription.*` handler; out of scope for M4. |

## Scope & non-goals

### In scope

- Clerk Billing JWT claims wired into Convex via `ctx.auth.getUserIdentity()`.
- Schema change: add `isPrivate: v.boolean()` to the `channels` table (default `false`).
- New Convex helper `assertFeature(ctx, featureKey)` with typed `PaywallError`.
- New / modified mutations: `channels.create` (adds `isPrivate` arg, gates on `private_channels`); `channels.invite` (new); `channels.listBrowsable` (filter out private).
- Modified query: `messages.list` enforces 10,000-message cap for Free; returns `cappedByPlan: boolean` alongside pagination fields.
- New query: `workspace.listMembers` for the invite picker.
- New route: `/[slug]/settings/billing/page.tsx` (admin-only) hosting `<PricingTable />`.
- New UI components: `InviteToChannelModal`, paywall card inside `MessageList`, Upgrade pill in `WorkspaceSidebar`.
- Modified UI components: `CreateChannelModal` (Private checkbox, disabled-with-badge on Free), `ChannelHeader` ("Add people" button on private channels), `WorkspaceSidebar` (🔒 prefix on private channels).
- New client hook: `useHasFeature(featureKey)` reading session claims.
- Unit tests: `auth.test.ts` (new), `channels.test.ts` (extended), `messages.test.ts` (extended), `workspace.test.ts` (extended).

### Explicitly out of scope (deferred)

- No Stripe integration code — Clerk's `<PricingTable />` handles checkout, trials, card updates, invoices, and cancellation.
- No subscription event handling in Convex webhooks (JWT is authoritative).
- No per-user plans (only organization plans).
- No seat-based billing (fixed monthly/annual fee).
- No custom trial logic (3-day trial is configured in Clerk dashboard).
- No grace period / dunning UI — Clerk handles failed payments.
- No feature gates beyond the two agreed (private channels, unlimited history). DMs, reactions, file uploads stay part of future milestones.
- No archive/hide UI for private channels on downgrade — they stay visible to existing members.
- No `messageCount` denormalized counter on channels — we compute the 10k cap on the fly; revisit only if profiling shows a problem.
- No admin audit log of plan changes.

## Architecture & data flow

One new pipe connects Clerk Billing to Convex: the session JWT. No new tables, no new webhook handlers.

```
┌─────────────────┐                  ┌─────────────────────┐
│ Clerk Billing   │─── JWT claims ──▶│ Convex              │
│ (org_plan,      │  (refreshed      │ ctx.auth            │
│  org_features)  │   ~every 60s)    │ .getUserIdentity()  │
└────────┬────────┘                  └──────────┬──────────┘
         │                                      │
         │ user subscribes via                  │ assertFeature(ctx, key)
         │ <PricingTable/> on                   │   ├─ reads identity claims
         │ /[slug]/settings/billing             │   └─ throws PaywallError(key)
         ▼                                      ▼      if absent
   Stripe checkout (Clerk-hosted)         channels.create ({isPrivate: true})
                                          channels.invite
                                          messages.list  (history cap check)
```

All three gate sites — private channel creation, invitation, message history cap — go through the same `assertFeature` helper. No feature gate is enforced in Next.js server components; the Convex layer is the single source of truth. The UI uses `useHasFeature(key)` (from session claims) purely to *hint* at state — to disable the Private checkbox, show the Upgrade pill, etc. — but submitting never relies on client state.

### JWT staleness

Clerk refreshes the session JWT every ~60 seconds. When a workspace upgrades, there's a window up to one minute where `ctx.auth.getUserIdentity()` still shows Free. Three consequences:

- New Pro features won't work for ~60s after purchase. Acceptable.
- The UI should hint at this: after upgrade, show a brief "Features will activate shortly" banner on the billing page.
- We do NOT try to force-refresh the token — fragile, and Clerk's cookie refresh handles it.

### Plan key asymmetry

The user configured `free_org` and `pro` in Clerk dashboard, not both `*_org`. Accepted as-is; constants in `convex/billing.ts`:

```typescript
export const PLAN_FREE = "free_org";
export const PLAN_PRO  = "pro";
export const FEATURE_PRIVATE_CHANNELS       = "private_channels";
export const FEATURE_UNLIMITED_HISTORY      = "unlimited_message_history";
export const FEATURE_PUBLIC_CHANNELS        = "public_channels";   // defined but unused in gates
export const FEATURE_BASIC_MESSAGING        = "basic_messaging";   // defined but unused in gates
```

### JWT claim names (open implementation detail)

Clerk's documented JWT claims for Organization Billing are `o.pla` (plan key) and `o.fea` (feature keys array), exposed on Convex as `identity.o.pla` / `identity.o.fea` once we declare them on `auth.config.ts`'s `applicationID`. The plan step will verify by logging `identity` from a test mutation and pick the definitive access pattern; if Convex doesn't surface them natively, we extend the Clerk JWT template in the dashboard with explicit top-level claims:

```json
{ "org_plan": "{{org.subscription.plan.slug}}", "org_features": "{{org.subscription.features}}" }
```

The helper API in `auth.ts` stays the same either way.

## Convex changes

### Schema delta

```typescript
// convex/schema.ts — modify channels table
channels: defineTable({
  organizationId: v.id("organizations"),
  slug: v.string(),
  name: v.string(),
  createdBy: v.id("users"),
  isProtected: v.boolean(),
  isPrivate: v.boolean(),                    // NEW (default false; existing rows backfilled false)
})
  .index("by_organization", ["organizationId"])
  .index("by_organization_and_slug", ["organizationId", "slug"]),
```

No new tables. `channelMembers` already supports invite-based membership. `messages` is unchanged.

### New file: `convex/billing.ts`

Plan/feature key constants (see "Plan key asymmetry" above).

### Modified: `convex/auth.ts`

```typescript
export class PaywallError extends Error {
  constructor(public featureKey: string) {
    super(`Feature requires upgrade: ${featureKey}`);
    this.name = "PaywallError";
  }
}

export async function getPlan(ctx: QueryCtx | MutationCtx): Promise<{
  planKey: string | null;
  features: string[];
} | null>;

export async function assertFeature(
  ctx: QueryCtx | MutationCtx,
  featureKey: string
): Promise<void>;  // throws PaywallError when feature absent
```

### Modified: `convex/channels.ts`

- `create` gains `isPrivate?: boolean` (default false). When true, calls `assertFeature(ctx, "private_channels")` before insert.
- `listBrowsable` filters out rows with `isPrivate: true`.
- New `invite({ channelId, userId })`:
  - `assertChannelMember(caller)` — caller must be in the channel.
  - `assertMember(invitee)` — invitee must be in the workspace.
  - If the channel is private, `assertFeature(ctx, "private_channels")` — this is what blocks new invites after a Pro → Free downgrade.
  - Idempotent insert into `channelMembers`.
- New `listChannelMembers({ channelId })` → `Id<"users">[]` for the invite modal's "already added" filter.

### Modified: `convex/messages.ts`

`list` gains the cap enforcement. Pseudocode:

```typescript
export const list = query({
  args: { channelId, paginationOpts },
  handler: async (ctx, args) => {
    // existing auth: ensureUser + assertChannelMember
    const plan = await getPlan(ctx);
    const hasUnlimited = plan?.features.includes("unlimited_message_history") ?? false;

    let cutoffCreationTime: number | null = null;
    let cappedByPlan = false;

    if (!hasUnlimited) {
      const capProbe = await ctx.db
        .query("messages")
        .withIndex("by_channel", (q) => q.eq("channelId", args.channelId))
        .order("desc")
        .take(10_001);
      if (capProbe.length > 10_000) {
        cutoffCreationTime = capProbe[9_999]._creationTime;  // 10,000th newest
        cappedByPlan = true;
      }
    }

    let q = ctx.db
      .query("messages")
      .withIndex("by_channel", (q) => q.eq("channelId", args.channelId))
      .order("desc");
    if (cutoffCreationTime !== null) {
      q = q.filter((f) => f.gte(f.field("_creationTime"), cutoffCreationTime));
    }
    const result = await q.paginate(args.paginationOpts);

    // existing author-join unchanged
    return { ...result, cappedByPlan };
  },
});
```

`send` and `deleteMessage` are unchanged — Free workspaces can keep posting past 10k; they just can't read the older tail without upgrading.

### Modified: `convex/workspace.ts`

New `listMembers({ workspaceSlug })` returning the workspace's members with joined user rows, bounded `.take(200)`. Used by `InviteToChannelModal`.

## Next.js UI changes

### New route: `app/[slug]/settings/billing/page.tsx`

Admin-only. Server-side-less — pure `"use client"`. Reads `api.workspace.whoami` for role; non-admin → `router.replace(`/${slug}`)`. Renders Clerk's `<PricingTable newSubscriptionRedirectUrl={`/${slug}/channels/general`} />`. Shows a banner for ~60s after JWT refresh to explain activation lag (cookie-based flag set on subscribe success).

### New component: `components/messaging/InviteToChannelModal.tsx`

Opened from `ChannelHeader` on private channels. Fetches `workspace.listMembers` + `channels.listChannelMembers`, diffs, shows a searchable list with per-row "Add" button that calls `channels.invite`.

### Modified component: `components/messaging/CreateChannelModal.tsx`

Adds a "Private" checkbox. On Free workspaces the checkbox is disabled with a "Pro" badge and a tooltip; clicking the row opens `/[slug]/settings/billing` in a new tab. The `create` mutation call passes `isPrivate` through.

### Modified component: `components/messaging/ChannelHeader.tsx`

Adds an "Add people" button on private channels (next to the existing kebab). Opens `InviteToChannelModal`.

### Modified component: `components/messaging/WorkspaceSidebar.tsx`

- Private channels render with `🔒 slug` instead of `# slug`.
- When `useHasFeature("unlimited_message_history") === false`, render a small "⚡ Upgrade to Pro" pill above the user-button footer, linking to `/[slug]/settings/billing`.

### Modified component: `components/messaging/MessageList.tsx`

When the paginated result's last page has `cappedByPlan: true` and `status === "Exhausted"`, render a dashed card at the top of the list:

```
┌───────────────────────────────────────────┐
│ You've reached your 10,000-message        │
│ history. Upgrade to Pro to see older.     │
│ [ Upgrade to Pro → ]                      │
└───────────────────────────────────────────┘
```

If `usePaginatedQuery` doesn't expose per-page metadata cleanly, we add a supplementary `api.messages.historyStatus({ channelId })` returning `{ cappedByPlan }` for the banner.

### New hook: `hooks/useHasFeature.ts`

Reads `useAuth().sessionClaims.org_features` (or whatever claim name we settle on) and returns whether the current org has a feature. Returns `undefined` during initial session load so callers can avoid flashing unauthorized UI.

## Authorization rules

| Action | Who | Check |
|---|---|---|
| Create public channel | any workspace member | `assertMember` (unchanged) |
| Create private channel | any workspace member on Pro | `assertMember` + `assertFeature("private_channels")` |
| Invite to private channel | channel member on Pro | `assertChannelMember(caller)` + `assertMember(invitee)` + `assertFeature("private_channels")` |
| Join public channel | any workspace member | `assertMember` (unchanged) |
| Join private channel (direct) | *no one* — no `join` path; only `invite` | — |
| List browsable channels | any workspace member | filters out `isPrivate: true` |
| Read messages past 10k in a channel | channel member on Pro | `assertFeature("unlimited_message_history")` filters at `list` query |
| View `/settings/billing` | workspace admin | client-side role check + redirect |
| Purchase / downgrade | workspace admin | Clerk's `<PricingTable/>` enforces via Clerk SDK |

## Testing

### Unit tests

**`convex/auth.test.ts` (new)**
- `getPlan` returns null when no org is active in the identity.
- `assertFeature` succeeds when feature is present; throws `PaywallError` with the feature key when absent.

**`convex/channels.test.ts` (extended)**
- `create({isPrivate: true})` on Free → throws `PaywallError("private_channels")`; no channel row inserted.
- `create({isPrivate: true})` on Pro → succeeds; `isPrivate: true` persisted.
- `invite` on Pro private channel → adds channelMembers row, idempotent on double-call.
- `invite` on Free private channel (downgraded) → throws `PaywallError("private_channels")`.
- `invite` by non-channel-member caller → throws "Not a channel member".
- `invite` of non-workspace-member invitee → throws "Not a member".
- `listBrowsable` excludes private channels regardless of plan (defense-in-depth).
- `listChannelMembers` returns all channel user IDs.

**`convex/messages.test.ts` (extended)**
- Free channel with 9,500 messages → full return, `cappedByPlan: false`.
- Free channel with 10,500 messages → last-page `cappedByPlan: true`, oldest 500 not returned.
- Pro channel with 10,500 messages → all returned, `cappedByPlan: false`.
- Non-member on Free → still rejected with `Not a channel member` (cap check doesn't bypass auth).
- Cursor-crafting test: a Free user can't fetch the hidden 500 by passing an older cursor.

**`convex/workspace.test.ts` (extended)**
- `listMembers` returns all members with joined user info; rejects non-members with "Not a member".

### Testability caveat

`convex-test`'s `t.withIdentity(...)` must accept the custom plan/feature claims. If its current type signature is too narrow, we add a thin test helper `withIdentityAndPlan(t, { ..., planKey, features })` that does the same. The plan step will confirm exact shape against the installed version.

### Manual E2E (10 acceptance steps)

1. New Free workspace: sidebar footer shows "⚡ Upgrade to Pro" pill.
2. Admin opens `Create channel` modal: "Private" checkbox is present but disabled with a "Pro" badge; tooltip reads "Upgrade to Pro".
3. Non-admin visits `/[slug]/settings/billing` → redirected to `/[slug]`.
4. Admin visits `/[slug]/settings/billing` → `<PricingTable />` renders Free and Pro, correct prices, 3-day trial badge on Pro.
5. Admin subscribes to Pro via the Clerk-hosted Stripe test flow → redirected to `/[slug]/channels/general`. Within ~60 seconds the Upgrade pill disappears.
6. Admin creates private channel `engineering` → sidebar shows `🔒 engineering`, page loads at `/[slug]/channels/engineering`.
7. Admin opens "Add people" in `#engineering`, picks Bob → Bob's sidebar updates to show `🔒 engineering` in real time.
8. Bob opens "Browse channels" → `engineering` is not listed. Only public channels.
9. Seed 10,050 messages into a test channel via Convex Dashboard. As Free (after downgrade, step 10 order below), scroll to top → "Reached 10,000-message history" card with functioning Upgrade link. Re-upgrade → card disappears, older 50 messages load.
10. Downgrade Pro → Free via Clerk dashboard. Within ~60s: existing private channels stay visible + usable to their members; creating a *new* private channel fails with paywall; re-upgrading restores creation.

## Open risks

- **JWT claim name drift.** If Clerk changes the shape of billing claims between beta and GA, we need to update one place (`auth.ts.getPlan`). Mitigation: encapsulate claim-reading in `getPlan`.
- **JWT refresh lag UX.** Users who upgrade and expect instant features will see ~60s of "still Free" behavior. The billing page's post-purchase banner is the mitigation; anything more aggressive is fragile.
- **10k-cap probe cost.** `take(10_001)` on every Free list call for channels with >10k messages. Acceptable at M4 scale. If it hurts, add denormalized `messageCount` on `channels` and cache the cutoff.
- **Convex-test identity claims.** If the library doesn't accept arbitrary claims, we pay a small tax writing the seed helper. Worst case is ~20 lines of plumbing.
- **Plan key asymmetry.** `free_org` vs `pro` is baked in. Code already needs to reference plan keys as constants so the asymmetry is contained, but human readers will notice.

## Spec ↔ plan coverage check

| Section | Plan task (to be written) |
|---|---|
| JWT claim wiring + getPlan/assertFeature | ~2 tasks (helper + `auth.test.ts`) |
| Schema `isPrivate` | 1 task |
| `channels.create` gate | 1 task |
| `channels.invite` + `listChannelMembers` | 2 tasks |
| `channels.listBrowsable` filter | 1 task |
| `messages.list` cap logic | 2 tasks (implement + tests) |
| `workspace.listMembers` | 1 task |
| Billing page route | 1 task |
| Sidebar: Upgrade pill + 🔒 icon | 1 task |
| `CreateChannelModal` Private checkbox | 1 task |
| `ChannelHeader` Add-people + `InviteToChannelModal` | 2 tasks |
| `MessageList` cap card | 1 task |
| `useHasFeature` hook | 1 task |
| Manual E2E | 1 task |
| Finish + merge | 1 task |

Roughly 19 tasks, similar cadence to Messaging core.
