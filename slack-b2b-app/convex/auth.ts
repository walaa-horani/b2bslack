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
