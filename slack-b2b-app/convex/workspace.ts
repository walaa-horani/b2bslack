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
