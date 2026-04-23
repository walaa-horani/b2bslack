"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

const ALLOWED_EMOJI = ["👍", "❤️", "😂", "🎉", "😢", "👀"] as const;

type ReactionGroup = {
  emoji: string;
  count: number;
  userIds: Id<"users">[];
  userNames: string[];
};

function nameSummary(names: string[], emoji: string): string {
  if (names.length <= 5) return `${names.join(", ")} reacted with ${emoji}`;
  const head = names.slice(0, 5).join(", ");
  return `${head} and ${names.length - 5} more reacted with ${emoji}`;
}

export function ReactionBar({
  messageId,
  reactions,
  currentUserId,
}: {
  messageId: Id<"messages">;
  reactions: ReactionGroup[];
  currentUserId: Id<"users"> | null;
}) {
  const toggle = useMutation(api.reactions.toggle);
  const [pickerOpen, setPickerOpen] = useState(false);

  return (
    <div className="flex items-center gap-1 mt-1 flex-wrap">
      {reactions.map((r) => {
        const mine = !!currentUserId && r.userIds.includes(currentUserId);
        return (
          <button
            key={r.emoji}
            type="button"
            title={nameSummary(r.userNames, r.emoji)}
            onClick={() => void toggle({ messageId, emoji: r.emoji })}
            className={`text-xs px-1.5 py-0.5 rounded border ${
              mine
                ? "bg-blue-100 border-blue-300 dark:bg-blue-900/40 dark:border-blue-700"
                : "bg-zinc-100 border-zinc-200 dark:bg-zinc-800 dark:border-zinc-700"
            }`}
          >
            {r.emoji} {r.count}
          </button>
        );
      })}

      <div className="relative">
        <button
          type="button"
          className="text-xs px-1.5 py-0.5 rounded border border-zinc-200 dark:border-zinc-700 opacity-0 group-hover:opacity-100"
          onClick={() => setPickerOpen((v) => !v)}
          aria-label="Add reaction"
        >
          + 😀
        </button>
        {pickerOpen && (
          <div className="absolute bottom-full left-0 mb-1 flex gap-1 p-1 bg-white dark:bg-zinc-800 border rounded shadow z-10">
            {ALLOWED_EMOJI.map((e) => (
              <button
                key={e}
                type="button"
                className="text-lg hover:bg-zinc-100 dark:hover:bg-zinc-700 rounded px-1"
                onClick={() => {
                  void toggle({ messageId, emoji: e });
                  setPickerOpen(false);
                }}
              >
                {e}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
