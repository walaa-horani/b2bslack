import { v } from "convex/values";
import { query } from "./_generated/server";
import { assertMember, getAuthedUser, getFeatures } from "./auth";

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
 * Workspace home page data: org name, user name, role, plan + features.
 * Throws if the caller is not a member of `slug`. The UI consumes `planKey` +
 * `features` to render Upgrade pills and disable Pro-only inputs on Free plans.
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
      planKey: org.planKey ?? null,
      features: getFeatures(org),
    };
  },
});

/**
 * Lists all users in the workspace with their membership role. Used by the
 * invite-to-channel modal; returns a bounded 200 results. Throws if the caller
 * is not a member.
 */
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
      .sort((a, b) =>
        (a.user.name ?? a.user.email).localeCompare(b.user.name ?? b.user.email),
      );
  },
});
