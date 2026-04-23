import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
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

export const listForMessages = query({
  args: { messageIds: v.array(v.id("messages")) },
  handler: async (ctx, args) => {
    if (args.messageIds.length > 300) {
      throw new Error("Too many messageIds (max 300).");
    }
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");

    const rowsPerMessage = await Promise.all(
      args.messageIds.map((id) =>
        ctx.db
          .query("reactions")
          .withIndex("by_message", (q) => q.eq("messageId", id))
          .take(200),
      ),
    );
    const allRows: Doc<"reactions">[] = rowsPerMessage.flat();
    const uniqueUserIds = [...new Set(allRows.map((r) => r.userId))];
    const users = await Promise.all(uniqueUserIds.map((id) => ctx.db.get(id)));
    const nameById = new Map<Id<"users">, string>();
    for (const u of users) {
      if (u) nameById.set(u._id, u.name ?? "Unknown user");
    }

    const out: Record<
      Id<"messages">,
      Array<{ emoji: string; count: number; userIds: Id<"users">[]; userNames: string[] }>
    > = {};
    for (let i = 0; i < args.messageIds.length; i++) {
      const rows = rowsPerMessage[i];
      const groups = new Map<string, { userIds: Id<"users">[]; userNames: string[] }>();
      for (const r of rows) {
        const g = groups.get(r.emoji) ?? { userIds: [], userNames: [] };
        if (!g.userIds.includes(r.userId)) {
          g.userIds.push(r.userId);
          g.userNames.push(nameById.get(r.userId) ?? "Unknown user");
        }
        groups.set(r.emoji, g);
      }
      out[args.messageIds[i]] = [...groups.entries()].map(([emoji, g]) => ({
        emoji,
        count: g.userIds.length,
        userIds: g.userIds,
        userNames: g.userNames,
      }));
    }
    return out;
  },
});
