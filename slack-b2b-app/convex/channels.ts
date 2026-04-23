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
