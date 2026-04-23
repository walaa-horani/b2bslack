# Messaging Polish — Reactions, Typing, Unread

**Date:** 2026-04-23
**Status:** Draft, awaiting user review
**Milestone:** 5 of 6 (Foundation → Messaging core → Billing plans → **Messaging polish** → File uploads → Admin UX)
**Depends on:** [Foundation](2026-04-22-foundation-design.md), [Messaging core](2026-04-22-messaging-core-design.md), [Billing plans](2026-04-23-billing-plans-design.md)

## Summary

Add three chat-UX basics to the existing channels experience: emoji reactions, live typing indicators, and per-channel unread counts. All three are Free-tier (no Pro gates), additive to the existing schema, and built as three independent sub-systems that can be implemented in any order and tested in isolation. No DMs, no threads, no @mentions, no file uploads — those stay in later milestones.

## Decisions (captured during brainstorming)

| # | Decision | Choice |
|---|---|---|
| 1 | Reaction emoji set | **Fixed micro-set of 6:** 👍 ❤️ 😂 🎉 😢 👀. No picker library, no search. Server validates emoji is one of the allowed six. |
| 2 | Reaction display | **Count pill + hover tooltip with names.** `[👍 3]` → `title="Alice, Bob, Carol reacted with 👍"`. Own-reaction pill is visually distinct. |
| 3 | Typing scope | **Current channel only, text line above composer.** No sidebar fan-out, no header presence. |
| 4 | Typing cadence | **3-second throttled heartbeat while keypressing; 5-second server-side expiry.** Stale rows filtered out by a `expiresAt > now` clause in the list query; lazy GC, no cron. |
| 5 | Unread sidebar | **Bold channel name + numeric badge (`3`, `7`, `50+`).** Count computed by `channels.listMine` via a bounded 51-message probe per channel. |
| 6 | Mark-read trigger | **On channel mount + throttled bump while `atBottom` during live receipt.** ≤1 mutation per 2s per (user, channel). |
| 7 | Plan gating | **None.** All three features are Free-tier. Moat remains private channels + unlimited history. |

## Scope & non-goals

### In scope

- Three new Convex tables — `reactions`, `typingIndicators`, `channelReadStates` — each with its own indexes and its own module file.
- Three new Convex modules — `reactions.ts`, `typing.ts`, `reads.ts`.
- One extension to an existing module: `channels.listMine` returns a per-channel `unreadCount` (+ `overflow: boolean`).
- Three cascade additions in `clerkSync.ts` (channel-delete, membership-delete, org-delete transitive).
- Three new client hooks — `useTypingHeartbeat`, `useMarkChannelRead`, plus the query wiring inside the list.
- Two new UI components — `<ReactionBar>`, `<TypingBar>`.
- Small edits to `MessageRow`, `MessageComposer`, `MessageList`, `WorkspaceSidebar`.
- Unit tests in `convex/reactions.test.ts`, `convex/typing.test.ts`, `convex/reads.test.ts`, and extensions to `channels.test.ts` and `clerkSync.test.ts`.

### Explicitly out of scope (deferred)

- Custom emoji / uploaded emoji — not even in the roadmap.
- Emoji picker beyond the fixed six (full picker stays deferred).
- Reaction limits per plan tier (user explicitly chose no gates).
- Typing indicators on sidebar (cross-channel fan-out).
- "Jump to first unread" separator inside the message list — Slack's read-marker UI. Expensive to implement; revisit in M6 polish if needed.
- Per-mention unread counts / mention-only filters (no @mentions yet).
- Push / email notifications — separate product surface.
- Read receipts ("Bob saw your message").
- Desktop notifications / service worker.

## Architecture & data flow

Three parallel pipes, all additive, none touching the Messaging-core hot path (`messages.send`, `messages.list`, `messages.deleteMessage` unchanged).

```
┌──────────┐   toggle    ┌──────────┐         ┌───────────────────┐
│ Client   │────────────▶│ Convex   │────────▶│ reactions table   │
│ ReactionBar│           │ reactions │         │ by_message        │
└──────────┘   listForMessages (reactive)      └───────────────────┘

┌──────────┐  heartbeat  ┌──────────┐         ┌───────────────────┐
│ Composer │────────────▶│ Convex   │────────▶│ typingIndicators  │
│ TypingBar│    3s       │ typing   │         │ (expires 5s)      │
└──────────┘  listForChannel (reactive)        └───────────────────┘

┌──────────┐  markRead   ┌──────────┐         ┌───────────────────┐
│ Channel  │────────────▶│ Convex   │────────▶│ channelReadStates │
│ page     │             │ reads    │         │ (user, channel)   │
└──────────┘   channels.listMine (extended reactive) ─┐
                                                      │
                                                      ▼
                                    per-channel unread count in sidebar
```

**Why three independent sub-systems and not one "activity" table:** each has a different write cadence and a different read surface. Mixing them would force every sidebar unread refresh to contend with every typing heartbeat write — exactly the pattern the Convex guideline calls out.

**Why `typingIndicators` is its own table, not a field on `channelMembers`:** per the Convex guideline on separating high-churn operational data — a heartbeat write every 3 seconds invalidating every reader of the stable `channelMembers` row (used by the hot-path `listMine` and `assertChannelMember`) would cause unnecessary re-reads across the system.

## Convex schema additions

```typescript
// convex/schema.ts — appended

reactions: defineTable({
  messageId: v.id("messages"),
  userId: v.id("users"),
  emoji: v.string(),                    // one of ALLOWED_EMOJI
  channelId: v.id("channels"),          // denormalized for cascade + auth
})
  .index("by_message", ["messageId"])
  .index("by_message_user_emoji", ["messageId", "userId", "emoji"])
  .index("by_channel", ["channelId"])
  .index("by_user_and_channel", ["userId", "channelId"]),

typingIndicators: defineTable({
  channelId: v.id("channels"),
  userId: v.id("users"),
  organizationId: v.id("organizations"), // denormalized for workspace-leave cascade
  expiresAt: v.number(),
})
  .index("by_channel", ["channelId"])
  .index("by_channel_and_user", ["channelId", "userId"])
  .index("by_user_and_organization", ["userId", "organizationId"]),

channelReadStates: defineTable({
  userId: v.id("users"),
  channelId: v.id("channels"),
  organizationId: v.id("organizations"), // denormalized for workspace-leave cascade
  lastReadAt: v.number(),
})
  .index("by_user_and_channel", ["userId", "channelId"])
  .index("by_user_and_organization", ["userId", "organizationId"])
  .index("by_channel", ["channelId"]),
```

### Design notes

- **`reactions.channelId` is denormalized.** Needed by `by_channel` (channel-delete cascade) and by `by_user_and_channel` (workspace-leave cascade). Invariant maintained at insert-time — `toggle` reads the parent message and sets `channelId` from it.
- **No DB-level uniqueness on (messageId, userId, emoji).** Convex doesn't enforce uniqueness; `toggle` check-then-inserts. Two concurrent toggles by the same user+emoji are rare (same user has one session active), and the worst case is a duplicate row — resolved by pointing the next `toggle` at either of the duplicates (both delete, net-zero). Not worth a transaction lock.
- **`typingIndicators.expiresAt` is a wall-clock ms timestamp**, not a TTL offset. The list query filters `expiresAt > now` server-side; stale rows linger in the DB at a bounded cost (≤ channel-members × sometimes-active). Garbage collected opportunistically inside `heartbeat` when it touches its own row.
- **`channelReadStates` missing row ⇒ never read.** Saves a write for users who've never opened a channel. `channels.listMine`'s unread-count probe uses `lastReadAt ?? 0`, so every message counts as unread until the user visits for the first time.
- **No `messages` schema changes.** Reactions / read-state do not denormalize onto `messages` — keeps the hot-path `list` query untouched.

## Convex function surface

### `convex/reactions.ts`

Exports `ALLOWED_EMOJI`:

```typescript
export const ALLOWED_EMOJI = ["👍", "❤️", "😂", "🎉", "😢", "👀"] as const;
```

| Function | Args | Authorization | Behavior |
|---|---|---|---|
| `toggle` (mutation) | `{messageId, emoji}` | channel member | Validates `emoji ∈ ALLOWED_EMOJI`. Fetches the parent message (throws if missing, throws if `deletedAt`). `assertChannelMember(ctx, user._id, message.channelId)`. Looks up existing (message, user, emoji) via `by_message_user_emoji`. If present → `ctx.db.delete(row._id)`. Else → `ctx.db.insert` with `channelId` denormalized from message. |
| `listForMessages` (query) | `{messageIds: Id<"messages">[]}` | authenticated | Bounded `messageIds.length ≤ 300` (accommodates ~10 pages of `usePaginatedQuery` loads at `initialNumItems: 30`). For each id, `ctx.db.query("reactions").withIndex("by_message", q => q.eq("messageId", id)).take(200)`. Groups by emoji. Resolves unique userIds across the whole batch once, joins names via bounded `ctx.db.get`. Returns `Record<Id<"messages">, Array<{emoji, count, userIds, userNames}>>`. Does NOT individually re-check channel membership per message — the caller already saw them via `messages.list` which did the check. |

### `convex/typing.ts`

| Function | Args | Authorization | Behavior |
|---|---|---|---|
| `heartbeat` (mutation) | `{channelId}` | channel member | `assertChannelMember`. Looks up existing row via `by_channel_and_user`. If present → `ctx.db.patch(row._id, {expiresAt: Date.now() + 5000})`. If absent → `ctx.db.insert` with the caller's `organizationId` denormalized from the channel. |
| `stop` (mutation) | `{channelId}` | channel member | `assertChannelMember`. If caller's row exists, delete it. Idempotent. |
| `listForChannel` (query) | `{channelId}` | channel member | `assertChannelMember`. Fetches rows via `by_channel`, bounded `.take(50)`. Filters `expiresAt > Date.now()`. Excludes self (`userId !== user._id`). Joins names via bounded `ctx.db.get`. Returns `Array<{userId, name, expiresAt}>`. |

### `convex/reads.ts`

| Function | Args | Authorization | Behavior |
|---|---|---|---|
| `markRead` (mutation) | `{channelId}` | channel member | `assertChannelMember`. Look up existing (user, channel) row via `by_user_and_channel`. If present → `ctx.db.patch` `{lastReadAt: Date.now()}`. Else → `ctx.db.insert` with `organizationId` denormalized from channel. |

No `getUnreadCount` query — unread counts flow through the extended `channels.listMine` to keep the sidebar on a single subscription.

### Extension: `convex/channels.ts → listMine`

After the existing channel fetch, for each channel in the result:

```typescript
const readState = await ctx.db
  .query("channelReadStates")
  .withIndex("by_user_and_channel",
    q => q.eq("userId", user._id).eq("channelId", ch._id))
  .unique();
const lastReadAt = readState?.lastReadAt ?? 0;

const probe = await ctx.db
  .query("messages")
  .withIndex("by_channel", q => q.eq("channelId", ch._id))
  .order("desc")
  .take(51);

let unreadCount = 0;
for (const m of probe) {
  if (m._creationTime <= lastReadAt) break;   // probe is desc-ordered
  if (m.deletedAt) continue;
  if (m.userId === user._id) continue;        // own messages never unread
  unreadCount++;
}
const overflow = unreadCount > 50;
return { ...ch, unreadCount: Math.min(unreadCount, 50), overflow };
```

Note the `break` rather than `continue` — the probe is descending by `_creationTime`, so as soon as we hit a message older than `lastReadAt` everything after it is also read. This makes the average case cheap for active channels.

## UI — new components and hooks

### `components/messaging/ReactionBar.tsx`

- Props: `message: Doc<"messages">`, `reactions: Array<{emoji, count, userIds, userNames}>`, `currentUserId`.
- Renders one pill per emoji. Pill gets `bg-blue-100` if `userIds.includes(currentUserId)`.
- Pill `title` attribute: up to 5 names joined, then "and N more" (e.g. `"Alice, Bob, Carol reacted with 👍"`).
- Hover-visible `+` button on the right opens an inline 6-emoji strip (no modal, no library); click an emoji → `toggle(messageId, emoji)`.
- Hidden entirely when `message.deletedAt` is truthy.

### `components/messaging/TypingBar.tsx`

- Props: `channelId`.
- `useQuery(api.typing.listForChannel, {channelId})`.
- Local `setInterval(() => setTick(t => t+1), 1000)` to re-filter `expiresAt > Date.now()` between server events.
- Renders an always-present 20px-tall container (prevents composer jump). Empty when no typers.
- Text logic:
  - 1: `"{a} is typing…"`
  - 2: `"{a} and {b} are typing…"`
  - 3: `"{a}, {b}, and 1 other are typing…"`
  - 4+: `"Several people are typing…"`

### `hooks/useTypingHeartbeat.ts`

```typescript
export function useTypingHeartbeat(channelId: Id<"channels">) {
  const heartbeat = useMutation(api.typing.heartbeat);
  const stop = useMutation(api.typing.stop);
  const lastSentRef = useRef(0);
  const blurTimerRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    return () => { void stop({ channelId }); };
  }, [channelId, stop]);

  return {
    onKey: () => {
      const now = Date.now();
      if (now - lastSentRef.current < 3000) return;
      lastSentRef.current = now;
      void heartbeat({ channelId });
    },
    onSend: () => {
      lastSentRef.current = 0;
      void stop({ channelId });
    },
    onBlur: () => {
      if (blurTimerRef.current) clearTimeout(blurTimerRef.current);
      blurTimerRef.current = setTimeout(() => {
        void stop({ channelId });
      }, 1000);
    },
    onFocus: () => {
      if (blurTimerRef.current) {
        clearTimeout(blurTimerRef.current);
        blurTimerRef.current = null;
      }
    },
  };
}
```

Consumed by `MessageComposer`: `onChange` → `onKey`, Enter-submit → `onSend`, textarea `onBlur` / `onFocus`.

### `hooks/useMarkChannelRead.ts`

```typescript
export function useMarkChannelRead(
  channelId: Id<"channels">,
  atBottom: boolean,
  newestCreationTime: number | undefined,
) {
  const markRead = useMutation(api.reads.markRead);
  const lastSentRef = useRef(0);

  // On mount / channel change.
  useEffect(() => {
    lastSentRef.current = Date.now();
    void markRead({ channelId });
  }, [channelId, markRead]);

  // Bump when new messages arrive while viewing bottom.
  useEffect(() => {
    if (!atBottom || !newestCreationTime) return;
    const now = Date.now();
    if (now - lastSentRef.current < 2000) return;
    lastSentRef.current = now;
    void markRead({ channelId });
  }, [atBottom, newestCreationTime, channelId, markRead]);
}
```

Consumed by `MessageList` (or a tiny wrapper component around it) that already tracks `atBottom` and has access to the newest displayed message.

### Edits to existing components

- **`MessageRow.tsx`:** accepts a new `reactions` prop. Renders `<ReactionBar>` below the text when `reactions?.length > 0` OR on hover (shows the "+" button). Hidden on tombstone.
- **`MessageList.tsx`:** computes `messageIds = displayed.map(r => r.message._id)`, subscribes to `api.reactions.listForMessages`, passes per-row slices into `MessageRow`. Also invokes `useMarkChannelRead(channelId, atBottom, newestCreationTime)`.
- **`MessageComposer.tsx`:** wires `useTypingHeartbeat` into the textarea handlers.
- **Channel page (`app/[slug]/channels/[channel]/page.tsx`):** renders `<TypingBar channelId={...} />` between the `<MessageList>` and the `<MessageComposer>`.
- **`WorkspaceSidebar.tsx`:** channel row renders `className={isUnread ? "font-semibold" : ""}` and a right-aligned `<span>` with the badge (`overflow ? "50+" : String(unreadCount)`) when `unreadCount > 0`.

## Webhook / cascade changes (`convex/clerkSync.ts`)

### `channels.deleteChannel` (in `convex/channels.ts`, not a webhook handler)

Before the existing message + channelMember cascade, add three cascades (each using the `.take(256)` + self-reschedule pattern):

```typescript
// reactions cascade
const reactionBatch = await ctx.db.query("reactions")
  .withIndex("by_channel", q => q.eq("channelId", channelId))
  .take(256);
for (const r of reactionBatch) await ctx.db.delete(r._id);
if (reactionBatch.length === 256) {
  await ctx.scheduler.runAfter(0, api.channels.deleteChannel, { channelId });
  return;
}

// typingIndicators cascade
const typingBatch = await ctx.db.query("typingIndicators")
  .withIndex("by_channel", q => q.eq("channelId", channelId))
  .take(256);
// ... same pattern

// channelReadStates cascade
const readsBatch = await ctx.db.query("channelReadStates")
  .withIndex("by_channel", q => q.eq("channelId", channelId))
  .take(256);
// ... same pattern
```

### `deleteMembership` (webhook handler) — extended

Before the existing `channelMembers` cascade, add the three new tables keyed by `by_user_and_organization`:

- reactions — uses `by_user_and_channel`, iterates the user's `channelMembers` rows for the workspace to collect channelIds, deletes reactions per channel in batches. (Slightly more involved because `reactions` has no `by_user_and_organization` index — keeping the index set minimal.)
- typingIndicators — direct via `by_user_and_organization`.
- channelReadStates — direct via `by_user_and_organization`.

The user's `messages` still persist (part of channel history), consistent with Messaging core's decision.

### `deleteOrganization` — unchanged in spirit

Already cascades workspace-memberships + channels. The per-channel cascade (above) now includes the three new tables, so transitive coverage is automatic. Tests verify.

### `upsertOrganization`, `upsertMembership`, `deleteUser` — unchanged

No polish tables need seeding on workspace / membership creation. A fresh `channelReadStates` row is created lazily on first `markRead`.

## Authorization rules

| Action | Who | Check |
|---|---|---|
| Toggle reaction | channel member | `assertChannelMember` via parent message |
| List reactions for a page | authenticated user | No per-message re-check (batch piggybacks on `messages.list`'s auth) |
| Send typing heartbeat | channel member | `assertChannelMember` |
| Stop typing | channel member | `assertChannelMember` |
| List typers in channel | channel member | `assertChannelMember` |
| Mark channel read | channel member | `assertChannelMember` |
| Read unread counts | workspace member (via `listMine`) | Existing `assertMember`; only channels the user belongs to are returned |

## Testing

### Convex unit tests

- **`convex/reactions.test.ts` (new):**
  - `toggle` inserts a reactions row for a valid emoji.
  - `toggle` twice with same args removes the row.
  - `toggle` with an emoji outside `ALLOWED_EMOJI` throws.
  - `toggle` on a tombstoned message throws.
  - `toggle` by a non-member throws.
  - `listForMessages` groups by emoji across multiple users.
  - `listForMessages` returns an empty object for messages with no reactions.
  - `listForMessages` returns resolved names in `userNames`.

- **`convex/typing.test.ts` (new):**
  - `heartbeat` inserts a row with `expiresAt ~= now + 5000`.
  - Second `heartbeat` from the same user patches `expiresAt` on the existing row (no duplicate).
  - `stop` deletes the caller's row.
  - `listForChannel` excludes the caller.
  - `listForChannel` excludes rows where `expiresAt <= Date.now()` (use `vi.useFakeTimers`).
  - `listForChannel` rejects a non-member.

- **`convex/reads.test.ts` (new):**
  - First `markRead` inserts a row.
  - Subsequent `markRead` patches the existing row.
  - Rejects non-member.

- **`convex/channels.test.ts` (extended):**
  - `listMine` returns `unreadCount: 0` for a just-created read-state.
  - `listMine` returns `unreadCount: N` when N messages from others exist after `lastReadAt`.
  - `listMine` excludes own messages from the count.
  - `listMine` excludes tombstoned messages from the count.
  - `listMine` returns `50` + `overflow: true` when 51+ unread.
  - `listMine` returns `unreadCount` equal to all messages (minus own/tombstones) when no read-state row exists.
  - `deleteChannel` cascades reactions, typingIndicators, channelReadStates.

- **`convex/clerkSync.test.ts` (extended):**
  - `deleteMembership` removes the user's reactions for that workspace only (other-workspace reactions untouched).
  - `deleteMembership` removes the user's typingIndicators for that workspace only.
  - `deleteMembership` removes the user's channelReadStates for that workspace only.
  - `deleteOrganization` transitively removes all three via the per-channel cascade.

### No Playwright yet

Same rationale as Foundation / Messaging core / Billing. Revisit at M6.

### Manual E2E (12 steps, two browsers)

1. **Reactions toggle:** Alice reacts 👍 on Bob's message → pill appears in both browsers within ~1s. Alice clicks again → pill disappears.
2. **Reactions grouping:** Alice 👍 + Bob 👍 on same message → single `[👍 2]` pill; Alice's pill is highlighted (own-reaction style) in her browser only.
3. **Reactions names:** Hovering `[👍 2]` shows `title="Alice and Bob reacted with 👍"` (native tooltip).
4. **Reactions on tombstone:** Bob deletes his own message → ReactionBar disappears for both viewers; no residual click target.
5. **Typing shows:** Alice types in `# general` → Bob sees "Alice is typing…" within ~1s.
6. **Typing clears on send:** Alice hits Enter → typing bar vanishes for Bob immediately; Alice's message appears.
7. **Typing times out:** Alice types then walks away → Bob's typing bar disappears within ~6s (5s server expiry + 1s client poll).
8. **Typing privacy:** Non-member attempting `api.typing.listForChannel` on a private channel via Convex Dashboard is rejected.
9. **Unread badge on new messages:** Bob posts 3 messages in `# project-alpha` while Alice is viewing `# general` → Alice's sidebar shows `# project-alpha 3` bold within ~1s.
10. **Unread clears on click:** Alice clicks `# project-alpha` → badge disappears within ~1s; channel name un-bolds.
11. **Unread overflow:** Seed 55 messages via Convex Dashboard from Bob in a channel Alice is in but not viewing → Alice's sidebar shows `50+` badge.
12. **Cascade cleanup:** Admin deletes `# project-alpha`. Convex Dashboard confirms 0 rows in `reactions`, `typingIndicators`, `channelReadStates` for that channel.

## Migration / one-time setup

`npx convex dev` pushes the three additive tables. No Clerk dashboard changes. No new env vars. No new webhook handlers. Existing Messaging-core and Billing data is untouched.

Workspaces created before M5 will have no `channelReadStates` rows — `listMine` treats missing rows as "never read" and shows all existing messages as unread (capped at 50+) until each user first opens each channel. Acceptable; matches Slack behavior for new joiners.

## Open risks

1. **Convex reactivity + wall-clock expiry.** `typingIndicators.expiresAt` crossing `now` doesn't emit a reactive event on its own. Mitigation in `<TypingBar>`: 1-second `setInterval` re-filters local state. If UX still flickers in practice (tab throttle + sleepy clients), a 5-second client-side `heartbeat` no-op that forces a server tick is cheap to add post-hoc.
2. **`channels.listMine` cost at scale.** 51-message probe per joined channel × up to 200 channels = ~10.2k row reads per sidebar subscription. Acceptable at M5 scale. If profiling shows it's a problem, the fix is a denormalized `channels.lastMessageAt` column — if `lastMessageAt <= lastReadAt`, skip the probe entirely. Noted, not built.
3. **Typing heartbeat on backgrounded tabs.** Browsers throttle timers in background tabs; a typer whose tab backgrounds can miss a 3s heartbeat and flicker off the indicator. Acceptable — a backgrounded typer arguably shouldn't show as "typing" anyway.
4. **Duplicate reactions under race.** Two concurrent `toggle` calls by the same user+emoji could both pass the "does row exist?" check and both insert. Worst case: two duplicate reaction rows. Any subsequent toggle deletes both. Not worth a transaction lock.
5. **Self-reaction allowed.** Users can react to their own messages (matches Slack). Not prevented in code; documented here.
6. **Mark-read on fast channel-switch.** Clicking a channel and leaving within 2s still fires the mount `markRead`. Acceptable; the "read" semantics in chat UIs are already fuzzy and this matches user expectation ("I clicked it, clear the badge").
7. **Unread count imprecise when newest 51 include many own/tombstoned messages.** The `take(51)` probe is a window on the newest rows, so if ≥51 messages exist after `lastReadAt` but a large fraction are own-author or tombstoned, the displayed count under-reports the true "real unread" number. Consequence is under-count approaching the 50+ threshold. Acceptable because counts >10 rarely drive behavior and the cap is already "50+". If it ever matters we'd widen the probe or walk until we've observed 50 real-unreads.
8. **Reactions subscription grows with scrollback.** `listForMessages` is bounded at 300 message IDs. A user who loads 10+ pages of history will hit the cap and reactions on the oldest-displayed messages stop rendering. Acceptable for M5 — the typical session reads-then-stops-scrolling — and easy to lift post-hoc by chunking the reactions subscription per page.

## Spec ↔ plan coverage check

| Section | Plan task (to be written) |
|---|---|
| Schema additions (3 tables) | 1 task |
| `reactions.ts` functions + test | 2 tasks |
| `typing.ts` functions + test | 2 tasks |
| `reads.ts` function + test | 1 task |
| `channels.listMine` extension + test | 1 task |
| `channels.deleteChannel` cascade + test | 1 task |
| `clerkSync.deleteMembership` cascade + test | 1 task |
| `<ReactionBar>` + `MessageRow` wiring | 1 task |
| `<TypingBar>` + `useTypingHeartbeat` + `MessageComposer` + channel page | 2 tasks |
| `useMarkChannelRead` + `MessageList` wiring | 1 task |
| `WorkspaceSidebar` unread badge + bold | 1 task |
| Manual E2E walkthrough | 1 task |
| Finish + merge | 1 task |

Roughly 16 tasks. Similar cadence to Messaging core (17) and Billing plans (~19).
