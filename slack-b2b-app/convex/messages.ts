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

export const list = query({
  args: {
    channelId: v.id("channels"),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");
    const user = await ctx.db
      .query("users")
      .withIndex("by_token_identifier", (q) =>
        q.eq("tokenIdentifier", identity.tokenIdentifier),
      )
      .unique();
    if (!user) throw new Error("Not a channel member: no user record");
    await assertChannelMember(ctx, user._id, args.channelId);

    const result = await ctx.db
      .query("messages")
      .withIndex("by_channel", (q) => q.eq("channelId", args.channelId))
      .order("desc")
      .paginate(args.paginationOpts);

    // Join author info server-side so the client doesn't N+1.
    const authorIds = [...new Set(result.page.map((m) => m.userId))];
    const authors = await Promise.all(authorIds.map((id) => ctx.db.get(id)));
    const authorById = new Map(
      authors
        .filter((a): a is NonNullable<typeof a> => a !== null)
        .map((a) => [a._id, a]),
    );

    return {
      ...result,
      page: result.page.map((message) => {
        const a = authorById.get(message.userId);
        return {
          message,
          author: a
            ? { _id: a._id, name: a.name ?? null, imageUrl: a.imageUrl ?? null }
            : { _id: message.userId, name: null, imageUrl: null },
        };
      }),
    };
  },
});

export const deleteMessage = mutation({
  args: { messageId: v.id("messages") },
  handler: async (ctx, args) => {
    const user = await ensureUser(ctx);
    const message = await ctx.db.get(args.messageId);
    if (!message) throw new Error(`Message not found: ${args.messageId}`);
    if (message.userId !== user._id) {
      throw new Error("Not authorized: only the author can delete a message.");
    }
    await ctx.db.patch(message._id, { deletedAt: Date.now() });
  },
});
