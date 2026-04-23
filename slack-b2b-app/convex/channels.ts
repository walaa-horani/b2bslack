import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { assertChannelMember, assertMember, ensureUser, getAuthedUser } from "./auth";

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

export const join = mutation({
  args: { channelId: v.id("channels") },
  handler: async (ctx, args) => {
    const user = await ensureUser(ctx);
    const channel = await ctx.db.get(args.channelId);
    if (!channel) throw new Error(`Channel not found: ${args.channelId}`);

    const org = await ctx.db.get(channel.organizationId);
    if (!org) throw new Error("Channel belongs to an unknown workspace.");
    await assertMember(ctx, user._id, org.slug);

    const existing = await ctx.db
      .query("channelMembers")
      .withIndex("by_user_and_channel", (q) =>
        q.eq("userId", user._id).eq("channelId", channel._id),
      )
      .unique();
    if (existing) return existing._id;

    return await ctx.db.insert("channelMembers", {
      channelId: channel._id,
      userId: user._id,
      organizationId: channel.organizationId,
    });
  },
});

export const leave = mutation({
  args: { channelId: v.id("channels") },
  handler: async (ctx, args) => {
    const user = await ensureUser(ctx);
    const channel = await ctx.db.get(args.channelId);
    if (!channel) throw new Error(`Channel not found: ${args.channelId}`);
    if (channel.isProtected) {
      throw new Error(`Cannot leave the ${channel.slug} channel.`);
    }

    const membership = await ctx.db
      .query("channelMembers")
      .withIndex("by_user_and_channel", (q) =>
        q.eq("userId", user._id).eq("channelId", channel._id),
      )
      .unique();
    if (membership) await ctx.db.delete(membership._id);
  },
});

export const deleteChannel = mutation({
  args: { channelId: v.id("channels") },
  handler: async (ctx, args) => {
    const user = await ensureUser(ctx);
    const channel = await ctx.db.get(args.channelId);
    if (!channel) throw new Error(`Channel not found: ${args.channelId}`);
    if (channel.isProtected) {
      throw new Error(`Cannot delete the protected ${channel.slug} channel.`);
    }

    const org = await ctx.db.get(channel.organizationId);
    if (!org) throw new Error("Channel belongs to an unknown workspace.");
    const { membership } = await assertMember(ctx, user._id, org.slug);
    if (membership.role !== "org:admin") {
      throw new Error("Only workspace admins can delete channels.");
    }

    // Cascade messages (batched).
    const messages = await ctx.db
      .query("messages")
      .withIndex("by_channel", (q) => q.eq("channelId", channel._id))
      .take(256);
    for (const msg of messages) await ctx.db.delete(msg._id);

    // Cascade channelMembers (batched).
    const cmembers = await ctx.db
      .query("channelMembers")
      .withIndex("by_channel", (q) => q.eq("channelId", channel._id))
      .take(256);
    for (const cm of cmembers) await ctx.db.delete(cm._id);

    await ctx.db.delete(channel._id);
  },
});

export const listMine = query({
  args: { workspaceSlug: v.string() },
  handler: async (ctx, args) => {
    const user = await getAuthedUser(ctx);
    if (!user) return [];
    const { org } = await assertMember(ctx, user._id, args.workspaceSlug);

    const memberships = await ctx.db
      .query("channelMembers")
      .withIndex("by_user_and_organization", (q) =>
        q.eq("userId", user._id).eq("organizationId", org._id),
      )
      .take(200);

    const channels = await Promise.all(
      memberships.map((m) => ctx.db.get(m.channelId)),
    );
    return channels
      .filter((c): c is NonNullable<typeof c> => c !== null)
      .sort((a, b) => a.name.localeCompare(b.name));
  },
});

export const getBySlug = query({
  args: { workspaceSlug: v.string(), channelSlug: v.string() },
  handler: async (ctx, args) => {
    const user = await getAuthedUser(ctx);
    if (!user) throw new Error("Not authenticated");
    const { org, membership: workspaceMembership } = await assertMember(
      ctx,
      user._id,
      args.workspaceSlug,
    );

    const channel = await ctx.db
      .query("channels")
      .withIndex("by_organization_and_slug", (q) =>
        q.eq("organizationId", org._id).eq("slug", args.channelSlug),
      )
      .unique();
    if (!channel) throw new Error(`Channel not found: ${args.channelSlug}`);

    const { member } = await assertChannelMember(ctx, user._id, channel._id);

    // Member count (small workspaces — bounded .take(1000) is fine for core).
    const memberCount = (
      await ctx.db
        .query("channelMembers")
        .withIndex("by_channel", (q) => q.eq("channelId", channel._id))
        .take(1000)
    ).length;

    return {
      channel,
      membership: member,
      memberCount,
      role: workspaceMembership.role,
    };
  },
});

export const listBrowsable = query({
  args: { workspaceSlug: v.string() },
  handler: async (ctx, args) => {
    const user = await getAuthedUser(ctx);
    if (!user) return [];
    const { org } = await assertMember(ctx, user._id, args.workspaceSlug);

    const allChannels = await ctx.db
      .query("channels")
      .withIndex("by_organization", (q) => q.eq("organizationId", org._id))
      .take(200);

    const myMemberships = await ctx.db
      .query("channelMembers")
      .withIndex("by_user_and_organization", (q) =>
        q.eq("userId", user._id).eq("organizationId", org._id),
      )
      .take(200);
    const joinedIds = new Set(myMemberships.map((m) => m.channelId));

    return allChannels
      .filter((c) => !joinedIds.has(c._id))
      .sort((a, b) => a.name.localeCompare(b.name));
  },
});
