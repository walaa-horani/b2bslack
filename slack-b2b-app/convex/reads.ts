import { v } from "convex/values";
import { mutation } from "./_generated/server";
import { assertChannelMember, ensureUser } from "./auth";

export const markRead = mutation({
  args: { channelId: v.id("channels") },
  handler: async (ctx, args) => {
    const user = await ensureUser(ctx);
    const { channel } = await assertChannelMember(ctx, user._id, args.channelId);
    const existing = await ctx.db
      .query("channelReadStates")
      .withIndex("by_user_and_channel", (q) =>
        q.eq("userId", user._id).eq("channelId", args.channelId),
      )
      .unique();
    const lastReadAt = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, { lastReadAt });
    } else {
      await ctx.db.insert("channelReadStates", {
        userId: user._id,
        channelId: args.channelId,
        organizationId: channel.organizationId,
        lastReadAt,
      });
    }
  },
});
