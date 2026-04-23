import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { paginationOptsValidator } from "convex/server";
import { assertChannelMember, ensureUser } from "./auth";

const MAX_TEXT_LEN = 4000;

export const send = mutation({
  args: { channelId: v.id("channels"), text: v.string() },
  handler: async (ctx, args) => {
    const trimmed = args.text.trim();
    if (!trimmed) throw new Error("Message text cannot be empty.");
    if (trimmed.length > MAX_TEXT_LEN) {
      throw new Error(`Message exceeds maximum length of ${MAX_TEXT_LEN} characters.`);
    }

    const user = await ensureUser(ctx);
    await assertChannelMember(ctx, user._id, args.channelId);

    return await ctx.db.insert("messages", {
      channelId: args.channelId,
      userId: user._id,
      text: trimmed,
    });
  },
});
