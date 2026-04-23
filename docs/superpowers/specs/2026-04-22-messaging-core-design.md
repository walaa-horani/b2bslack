# Messaging Core — Channels & Messages

**Date:** 2026-04-22
**Status:** Draft, awaiting user review
**Milestone:** 3 of 6 (Foundation → Billing → **Messaging core** → Messaging polish → File uploads → Admin UX)
**Depends on:** [Foundation](2026-04-22-foundation-design.md)

## Summary

Ship the first user-visible feature on top of Foundation's auth + tenancy pipeline: public channels and plain-text messaging with real-time delivery and paginated history. Two members of the same workspace can exchange messages, create and join channels, and delete their own messages. Everything else — edit, private channels, DMs, threads, reactions, mentions, attachments — is deferred to later milestones.

## Decisions (captured during brainstorming)

| # | Decision | Choice |
|---|---|---|
| 1 | Scope (core vs polish) | **Core = public channels + send/view/soft-delete-own plain text + real-time + paginated history.** Everything else (edit, private, DMs, threads, reactions, mentions, typing, unread, search, markdown, files) is polish or later. |
| 2 | Channel membership model | **Explicit join** via a `channelMembers` join table (Slack-style). User sees joined channels in sidebar; must Browse + Join to enter others. |
| 3 | Default channel | **Auto-create `# general` on workspace creation + auto-join every new member. Protected** (cannot be left or deleted). |
| 4 | URL structure | **`/[slug]/channels/[channelSlug]`**. `/[slug]` redirects to `/[slug]/channels/general` on mount. |
| 5 | Message deletion | **Soft delete / tombstone.** `deletedAt` field; UI renders *"This message was deleted"*; text retained for possible future undo. |
| 6 | Who can create/delete channels | **Create:** any workspace member. **Delete:** admins only. **Delete-own-message:** author only (no admin moderation in core). |

## Scope & non-goals

### In scope

- `channels` table, `channelMembers` join table, `messages` table.
- Public channels (no private channel concept; `isProtected` flag is only for `# general`).
- Workspace-scoped: every channel belongs to exactly one organization; queries authorize via `assertMember` + `assertChannelMember`.
- Clerk webhook handlers extended to auto-create `# general` and auto-join members.
- Sidebar showing joined channels, "Create channel" modal, "Browse channels" modal.
- Channel page: header (name + member count), reverse-infinite-scroll message list, composer with Enter-to-send.
- Reactive real-time via Convex's native query subscriptions — no custom WebSockets.
- Paginated history via `usePaginatedQuery(api.messages.list, ...)` with `initialNumItems: 30` and scroll-to-load-older.

### Explicitly out of scope (deferred)

- Edit own message (milestone 4).
- Private channels (milestone 4).
- Direct Messages / group DMs (milestone 4).
- Threads / replies (milestone 4).
- Reactions (milestone 4).
- @mentions (user or channel) (milestone 4).
- Typing indicators (milestone 4).
- Unread counts, last-read tracking (milestone 4).
- Search (milestone 4).
- Markdown / rich text (milestone 4).
- Message drafts (milestone 4).
- Pins (milestone 4).
- File attachments (milestone 5).
- Admin moderation delete (any admin can delete any message) — deliberately excluded from core; a single authorization rule keeps `deleteMessage` simple.
- Notifications (email, push) — a separate product area.

## Architecture & data flow

Builds on Foundation's three-actor model (Clerk ↔ Next ↔ Convex). No new actors, no new pipes. What's new is:

1. **Three new Convex tables** — `channels`, `channelMembers`, `messages`.
2. **Two new Convex modules** — `channels.ts` (8 functions), `messages.ts` (3 functions), plus one helper added to `auth.ts` (`assertChannelMember`).
3. **Three Foundation webhook handlers gain logic** — `upsertMembership`, `deleteMembership`, `deleteOrganization`. `upsertOrganization` and `deleteUser` are unchanged.
4. **New Next.js route** — `/[slug]/channels/[channel]`. `/[slug]` becomes a redirect.
5. **New UI components** — one sidebar, one channel page, two modals, plus message list + row + composer.

Real-time delivery is handled entirely by Convex's reactive queries — `useQuery` / `usePaginatedQuery` re-run when their underlying rows change, no manual subscription code.

## Convex schema additions

```typescript
// convex/schema.ts — appended to Foundation's schema

channels: defineTable({
  organizationId: v.id("organizations"),
  slug: v.string(),                        // unique per org; lowercased, hyphenated
  name: v.string(),                        // display name
  createdBy: v.id("users"),
  isProtected: v.boolean(),                // true only for # general
})
  .index("by_organization", ["organizationId"])
  .index("by_organization_and_slug", ["organizationId", "slug"]),

channelMembers: defineTable({
  channelId: v.id("channels"),
  userId: v.id("users"),
  organizationId: v.id("organizations"),   // denormalized for sidebar query
})
  .index("by_channel", ["channelId"])
  .index("by_user_and_channel", ["userId", "channelId"])
  .index("by_user_and_organization", ["userId", "organizationId"]),

messages: defineTable({
  channelId: v.id("channels"),
  userId: v.id("users"),                   // author
  text: v.string(),
  deletedAt: v.optional(v.number()),       // tombstone
})
  .index("by_channel", ["channelId"]),
```

### Design notes

- **`channels.isProtected`** is set to `true` in exactly one place — the webhook handler that auto-creates `# general`. Everywhere else (including the `channels.create` public mutation), it's set to `false`. `channels.leave` and `channels.deleteChannel` check this flag and throw. Cheaper than a side table of "workspace invariants," and a single `git grep isProtected` reveals the whole enforcement.
- **`channelMembers.organizationId` is denormalized.** The hot-path sidebar query is *"list channels user X is in, within workspace Y."* Without denorm, it's a two-step join (channelMembers by user → channels by id → filter by org). With denorm + `by_user_and_organization`, it's a single indexed walk. The invariant is maintained by the same code that inserts a channelMember (webhook auto-join, explicit join, channel-create creator-join).
- **`messages.text` retained on soft delete.** Storing the content even after tombstoning enables future "undo delete" without a schema change. If stronger privacy is ever needed, a scrub-on-delete setting lives in polish. UI gates rendering on `deletedAt`.
- **No `by_user` index on `messages` for core.** Only needed for "delete all messages from user X" admin operations, which aren't in scope.
- **Ordering** uses the automatic `_creationTime`. `.query("messages").withIndex("by_channel", q => q.eq("channelId", x)).order("desc").paginate(...)` gives newest-first pagination with cursor stability — the Slack/Discord pattern.
- **No DB-level uniqueness on `channels.slug`.** Convex doesn't enforce uniqueness; the `channels.create` mutation check-then-inserts and throws on collision.
- **Cascade deletes** (channel → messages + channelMembers; org → channels → their contents) use `.take(256)` batches + `ctx.scheduler.runAfter(0, ...)` self-reschedule if a batch is full, matching Foundation's existing cascade pattern.

## Convex function surface

### New helper in `convex/auth.ts`

```typescript
export async function assertChannelMember(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
  channelId: Id<"channels">,
): Promise<{ channel: Doc<"channels">; member: Doc<"channelMembers"> }>
```

Fetches the channel, verifies existence and workspace ownership, confirms the `channelMembers` row exists. Every channel-scoped function starts with this one line.

### `convex/channels.ts`

**Queries:**

| Function | Args | Purpose |
|---|---|---|
| `listMine` | `{ workspaceSlug }` | Sidebar. Returns channels the caller belongs to, sorted by `name`. Uses `channelMembers.by_user_and_organization` → fetches each channel. Bounded `.take(200)`. |
| `getBySlug` | `{ workspaceSlug, channelSlug }` | Channel page header + permission check. Returns `{ channel, membership }` or throws. |
| `listBrowsable` | `{ workspaceSlug }` | "Browse channels" dialog. Public channels the caller isn't in. Bounded `.take(200)`. |

**Mutations:**

| Function | Args | Authorization | Behavior |
|---|---|---|---|
| `create` | `{ workspaceSlug, name, slug }` | workspace member | Validates slug format (`^[a-z0-9][a-z0-9-]{0,79}$`), checks uniqueness in org, inserts channel with `isProtected: false`, auto-inserts creator's `channelMembers` row. |
| `join` | `{ channelId }` | workspace member (not already in channel) | Idempotent. Inserts `channelMembers`. |
| `leave` | `{ channelId }` | channel member | Throws if `channel.isProtected`. Deletes caller's `channelMembers`. |
| `deleteChannel` | `{ channelId }` | **admin** of the workspace | Throws if `channel.isProtected`. Cascade-deletes messages + channelMembers (batched), then the channel. |

### `convex/messages.ts`

**Query:**

| Function | Args | Purpose |
|---|---|---|
| `list` | `{ channelId, paginationOpts }` | Paginated messages newest-first. `assertChannelMember` first. Returns `{ page: Array<{message, author: {_id, name, imageUrl}}>, isDone, continueCursor }` with authors resolved server-side to avoid N+1. |

**Mutations:**

| Function | Args | Authorization | Behavior |
|---|---|---|---|
| `send` | `{ channelId, text }` | channel member | Trims text, rejects empty or >4000 chars. Inserts `messages` row with caller as `userId`. |
| `deleteMessage` | `{ messageId }` | **message author only** | Patches `deletedAt: Date.now()`. Text retained. Non-authors (including admins) rejected. |

### Cross-cutting notes

- **`workspaceSlug` appears in every public mutation's args.** Every handler starts with `assertMember(ctx, user._id, workspaceSlug)` — belt-and-suspenders authorization. One indexed row read per call.
- **Slug collision on `channels.create`** throws a typed error. UI catches it and surfaces inline "This channel name is taken."
- **No `messages.edit` in core.** Polish.
- **No admin moderation delete in core.** Intentional — keeps `deleteMessage` to a single rule.

## Changes to Foundation webhook handlers

All additive. Foundation's existing tests keep passing. Updates land in `convex/clerkSync.ts`.

### `upsertMembership` (on `organizationMembership.created`) — biggest change

After inserting the workspace membership row:

```typescript
// 1. Ensure # general exists in this workspace (idempotent).
const general = await ctx.db
  .query("channels")
  .withIndex("by_organization_and_slug",
    q => q.eq("organizationId", org._id).eq("slug", "general"))
  .unique();
const generalId = general?._id ?? await ctx.db.insert("channels", {
  organizationId: org._id,
  slug: "general",
  name: "General",
  createdBy: user._id,
  isProtected: true,
});

// 2. Add new user to every protected channel in this workspace.
const protectedChannels = await ctx.db
  .query("channels")
  .withIndex("by_organization", q => q.eq("organizationId", org._id))
  .collect();
for (const ch of protectedChannels) {
  if (!ch.isProtected) continue;
  const already = await ctx.db.query("channelMembers")
    .withIndex("by_user_and_channel",
      q => q.eq("userId", user._id).eq("channelId", ch._id))
    .unique();
  if (!already) {
    await ctx.db.insert("channelMembers", {
      userId: user._id,
      channelId: ch._id,
      organizationId: org._id,
    });
  }
}
```

**Why create `# general` here, not in `upsertOrganization`?** At the moment `organization.created` fires, the creator's Convex user row might not yet exist (webhooks can arrive out of order). Deferring channel creation to the first `organizationMembership.created` event guarantees both parents exist. Concurrent first-member events are handled idempotently by the check-then-insert pattern.

### `deleteMembership` (on `organizationMembership.deleted`)

Before deleting the workspace membership row, remove the user from every channel in this workspace:

```typescript
const channelMemberships = await ctx.db
  .query("channelMembers")
  .withIndex("by_user_and_organization",
    q => q.eq("userId", user._id).eq("organizationId", membership.organizationId))
  .take(256);
for (const cm of channelMemberships) await ctx.db.delete(cm._id);
```

Their messages stay — part of conversation history, author's user row still exists.

### `deleteOrganization` (on `organization.deleted`)

Add channel cascade in front of the existing workspace-membership cascade:

1. Fetch up to 256 channels for this org.
2. For each channel: take up to 256 messages → delete; take up to 256 channelMembers → delete; delete the channel row.
3. If the original `.take(256)` was full, `ctx.scheduler.runAfter(0, internal.clerkSync.deleteOrganization, {clerkOrgId})` and return — same batching pattern Foundation uses.
4. Existing workspace-membership cascade.
5. Delete the org row.

### `upsertOrganization`, `deleteUser` — unchanged

Org creation doesn't need to do anything channel-related (handled by first membership). User deletion already cascades workspace memberships, and the extended `deleteMembership` above handles channel cleanup from there.

## Routes, layout, components

### Route map

| Route | Who renders | Notes |
|---|---|---|
| `/[slug]` | Foundation page (modified) | On mount, redirects to `/[slug]/channels/general`. Identity info (welcome banner) removed; lives in sidebar now. |
| `/[slug]/channels/[channel]` | new client page | Main app view. Renders via the two-column `/[slug]/layout.tsx`. |
| `/[slug]/members` | Foundation | Unchanged. |

No dedicated route for "Create channel" or "Browse channels" — those are modals triggered from the sidebar.

### Layout — two-column shell

`/[slug]/layout.tsx` wraps every `/[slug]/*` page with:

- **Left column (260px fixed):** `<WorkspaceSidebar>` — `<OrganizationSwitcher>`, "Channels" header with `+` button, joined-channels list with active highlighting, "Browse channels…" link, `<UserButton>` at bottom.
- **Right column:** `children` — the per-route content (channel page, members page, etc.).
- `<SyncActiveOrg>` continues to wrap the tree.

### New components

| Component | File | Responsibility |
|---|---|---|
| `<WorkspaceSidebar>` | `components/messaging/WorkspaceSidebar.tsx` | Queries `api.channels.listMine`. Highlights active via `usePathname()`. `+` opens `<CreateChannelModal>`. "Browse…" opens `<BrowseChannelsModal>`. |
| `<ChannelHeader>` | `components/messaging/ChannelHeader.tsx` | Channel name, member count (via `api.channels.getBySlug`), kebab menu with admin-only Delete. If `getBySlug` throws (e.g., channel was just deleted by an admin while the user was viewing it), the channel page catches the error and redirects to `/[slug]/channels/general`. |
| `<MessageList>` | `components/messaging/MessageList.tsx` | `usePaginatedQuery(api.messages.list, {channelId}, {initialNumItems: 30})`. Reverses client-side for display. Auto-scroll on mount + own-send. "New messages ↓" pill if user scrolled up. Load older on scroll-to-top. |
| `<MessageRow>` | `components/messaging/MessageRow.tsx` | Author name + relative time + text. If `deletedAt`, renders italic *"This message was deleted"* instead. Delete button visible only to author. |
| `<MessageComposer>` | `components/messaging/MessageComposer.tsx` | Textarea, Enter-to-send, Shift+Enter newline, char counter above 3800, disable Send while empty or pending. |
| `<CreateChannelModal>` | `components/messaging/CreateChannelModal.tsx` | Form: display name auto-slugifies to preview `#slug`. Submits `api.channels.create`; on success navigates to new channel. Catches slug-collision error inline. |
| `<BrowseChannelsModal>` | `components/messaging/BrowseChannelsModal.tsx` | `api.channels.listBrowsable`. Each row: Join button → `api.channels.join` → navigate. |

All client components. No server components talk to Convex — hooks end-to-end.

### Real-time strategy

Convex reactive queries handle it natively. `useQuery` and `usePaginatedQuery` re-run when underlying rows change. No WebSocket plumbing, no optimistic UI in core. ~50ms round-trip feels instant.

### Pagination + scroll

1. Mount: load newest 30, reverse for display (oldest-top), scroll to bottom.
2. New message while at bottom: auto-scroll to keep bottom anchored.
3. New message while scrolled up: don't auto-scroll; show "New messages ↓" pill.
4. Scroll near top (~200px): fire `loadMore(30)`. Before the load, capture `scrollHeight`; after, restore `scrollTop += (newScrollHeight - oldScrollHeight)`.

### Styling

Tailwind only. Consistent with Foundation — Clerk `appearance` prop themes Clerk components; raw Tailwind for custom chrome. No new UI library.

## Acceptance criteria

Messaging core is done when two browser windows, signed in as two members of the same workspace, can complete all ten steps end-to-end on dev Convex + dev Clerk:

1. **Alice signs in**, lands on `/acme`, browser auto-redirects to `/acme/channels/general`. Sidebar shows `# general` highlighted. `<UserButton>` in bottom-left.
2. **Alice posts "hello"** and sees it appear instantly at the bottom of the message list with her name and timestamp.
3. **Bob (second window, same workspace) sees "hello"** appear in his `# general` within ~1 second without any action.
4. **Alice creates channel "Project Alpha"** via the sidebar `+` button. URL navigates to `/acme/channels/project-alpha`, sidebar shows it highlighted, message list empty, composer ready.
5. **Bob doesn't see `# project-alpha`** in his sidebar. Clicking "Browse channels…" shows it with a Join button.
6. **Bob clicks Join.** Modal closes, sidebar updates, Bob navigates to `/acme/channels/project-alpha`.
7. **Alice posts 35 messages.** Bob scrolls up; older messages prepend via `usePaginatedQuery`; scroll position preserved.
8. **Alice deletes her own message** via the row's delete button. Text becomes italic *"This message was deleted"* in her view. Bob sees the tombstone within ~1 second. Bob has no Delete button on Alice's messages.
9. **Alice tries to leave `# general`** — blocked with error "Cannot leave the general channel." Menu hides Leave for protected channels as a first-line guard.
10. **Alice (admin) deletes `# project-alpha`** via channel kebab. Channel disappears from both sidebars within ~1 second. Bob's browser, currently on `/acme/channels/project-alpha`, redirects to `/acme/channels/general`. Convex Dashboard confirms zero rows in channels / messages / channelMembers for that channel.

Additional invariants verified via Convex Dashboard:

- A new Clerk-invited workspace member lands with a pre-existing `channelMembers` row for `# general`, created by the webhook.
- A member removed from the workspace loses all their `channelMembers` rows for that workspace; historical messages persist; the user's Convex row is intact.
- Deleting the workspace in Clerk cascades channels, messages, channelMembers, and workspace memberships to zero rows for that `clerkOrgId`.

## Testing

Three layers, following Foundation's pattern.

### Convex unit tests

New files:

- `convex/channels.test.ts` — create (slug format, collision, creator-joined), join (idempotent), leave (protected-blocked), deleteChannel (admin-only, protected-blocked, cascade), listMine / listBrowsable / getBySlug.
- `convex/messages.test.ts` — send (member-only, length, empty), list (paginates + includes author), deleteMessage (author-only, tombstone).

Extensions to `convex/clerkSync.test.ts`:

- `upsertMembership` creates `# general` on first membership of a workspace.
- Second membership in same workspace doesn't duplicate `# general`.
- Every new membership gets a `channelMembers` row for `# general`.
- `deleteMembership` cascades channelMembers within the workspace only.
- `deleteOrganization` cascades channels → messages + channelMembers, in addition to workspace memberships.

New helper tests in `convex/auth.test.ts` (creating the file if it doesn't already exist):

- `assertChannelMember` allows member, throws for non-member, throws for unknown channel.

### No Playwright yet

Same rationale as Foundation. Revisit after polish (#4).

### Manual E2E

The 10 acceptance steps above, run by a human before declaring the milestone done.

## Migration / one-time setup

Essentially nothing. `npx convex dev` pushes the additive schema. No Clerk dashboard changes. No new env vars. No new webhook registration.

One caveat: workspaces created during Foundation testing have no `# general` — `organizationMembership.created` events for them already fired and ran the old handler. For clean Messaging E2E, delete old test workspaces and create a fresh one so the extended webhook fires end-to-end.

## Open risks

1. **Scroll-restore on `loadMore` can feel janky** if the browser batches layout reads/writes unpredictably. Mitigation: the `scrollTop` adjustment runs inside `useLayoutEffect` after the paginated results update. If still janky, a virtualization library is a polish concern.
2. **Convex `_creationTime` collisions** across two near-simultaneous sends. The pagination cursor is stable because Convex breaks ties by `_id`. Messages display in a predictable but not always "wall-clock" order when two posts happen within the same tick — acceptable for core.
3. **Sidebar reactivity on channel-created-elsewhere.** `usePaginatedQuery` on the channels list reacts when the user's own `channelMembers` changes, but a channel created by someone else that the user hasn't joined won't trigger a sidebar refresh. That's correct — the user only sees joined channels. `<BrowseChannelsModal>` is the discovery surface and has its own reactive query.
4. **`channels.create` / `join` don't defend against racing slug creation.** Two clients creating "project-alpha" at the same instant could both pass the uniqueness check and both insert. Convex's per-mutation transactional guarantees make this very unlikely but not impossible. If it ever happens we'd have two channels with slug "project-alpha" for one org, and `getBySlug`'s `.unique()` would throw. Deferred: worth a cleanup sweep + UI error recovery in polish.
