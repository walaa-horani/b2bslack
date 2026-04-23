import { v } from "convex/values";
import { mutation } from "./_generated/server";
import { assertChannelMember, ensureUser } from "./auth";

export const ALLOWED_EMOJI = ["👍", "❤️", "😂", "🎉", "😢", "👀"] as const;
type AllowedEmoji = (typeof ALLOWED_EMOJI)[number];

function isAllowed(e: string): e is AllowedEmoji {
  return (ALLOWED_EMOJI as readonly string[]).includes(e);
}

export const toggle = mutation({
  args: { messageId: v.id("messages"), emoji: v.string() },
  handler: async (ctx, args) => {
    if (!isAllowed(args.emoji)) {
      throw new Error(`Emoji not allowed: ${args.emoji}`);
    }
    const message = await ctx.db.get(args.messageId);
    if (!message) throw new Error(`Message not found: ${args.messageId}`);
    if (message.deletedAt) throw new Error("Cannot react to a deleted message.");

    const user = await ensureUser(ctx);
    await assertChannelMember(ctx, user._id, message.channelId);

    const existing = await ctx.db
      .query("reactions")
      .withIndex("by_message_user_emoji", (q) =>
        q
          .eq("messageId", args.messageId)
          .eq("userId", user._id)
          .eq("emoji", args.emoji),
      )
      .unique();

    if (existing) {
      await ctx.db.delete(existing._id);
      return { toggled: "off" as const };
    }
    await ctx.db.insert("reactions", {
      messageId: args.messageId,
      userId: user._id,
      emoji: args.emoji,
      channelId: message.channelId,
    });
    return { toggled: "on" as const };
  },
});
