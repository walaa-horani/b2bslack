import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { assertChannelMember, ensureUser, getAuthedUser } from "./auth";
import type { Id } from "./_generated/dataModel";

const TTL_MS = 5000;

export const heartbeat = mutation({
  args: { channelId: v.id("channels") },
  handler: async (ctx, args) => {
    const user = await ensureUser(ctx);
    const { channel } = await assertChannelMember(ctx, user._id, args.channelId);
    const existing = await ctx.db
      .query("typingIndicators")
      .withIndex("by_channel_and_user", (q) =>
        q.eq("channelId", args.channelId).eq("userId", user._id),
      )
      .unique();
    const expiresAt = Date.now() + TTL_MS;
    if (existing) {
      await ctx.db.patch(existing._id, { expiresAt });
    } else {
      await ctx.db.insert("typingIndicators", {
        channelId: args.channelId,
        userId: user._id,
        organizationId: channel.organizationId,
        expiresAt,
      });
    }
  },
});

export const stop = mutation({
  args: { channelId: v.id("channels") },
  handler: async (ctx, args) => {
    const user = await ensureUser(ctx);
    await assertChannelMember(ctx, user._id, args.channelId);
    const existing = await ctx.db
      .query("typingIndicators")
      .withIndex("by_channel_and_user", (q) =>
        q.eq("channelId", args.channelId).eq("userId", user._id),
      )
      .unique();
    if (existing) await ctx.db.delete(existing._id);
  },
});

export const listForChannel = query({
  args: { channelId: v.id("channels") },
  handler: async (ctx, args) => {
    const user = await getAuthedUser(ctx);
    if (!user) throw new Error("Not authenticated");
    await assertChannelMember(ctx, user._id, args.channelId);
    const now = Date.now();
    const rows = await ctx.db
      .query("typingIndicators")
      .withIndex("by_channel", (q) => q.eq("channelId", args.channelId))
      .take(50);
    const live = rows.filter((r) => r.expiresAt > now && r.userId !== user._id);
    const names = await Promise.all(live.map((r) => ctx.db.get(r.userId)));
    return live.map((r, i) => ({
      userId: r.userId as Id<"users">,
      name: names[i]?.name ?? "Unknown user",
      expiresAt: r.expiresAt,
    }));
  },
});
