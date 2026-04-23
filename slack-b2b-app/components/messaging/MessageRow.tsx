"use client";

import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { ReactionBar } from "@/components/messaging/ReactionBar";

type ReactionGroup = {
  emoji: string;
  count: number;
  userIds: Id<"users">[];
  userNames: string[];
};

function formatTime(creationTime: number): string {
  const d = new Date(creationTime);
  const hh = d.getHours().toString().padStart(2, "0");
  const mm = d.getMinutes().toString().padStart(2, "0");
  return `${hh}:${mm}`;
}

export function MessageRow({
  message,
  author,
  isOwn,
  reactions,
  currentUserId,
}: {
  message: Doc<"messages">;
  author: { _id: Id<"users">; name: string | null; imageUrl: string | null };
  isOwn: boolean;
  reactions?: ReactionGroup[];
  currentUserId: Id<"users"> | null;
}) {
  const deleteMessage = useMutation(api.messages.deleteMessage);
  const tombstoned = !!message.deletedAt;

  return (
    <div className="group flex gap-3 px-4 py-1 hover:bg-zinc-50 dark:hover:bg-zinc-900/30">
      <div className="w-9 h-9 rounded bg-zinc-300 dark:bg-zinc-700 flex-shrink-0 overflow-hidden">
        {author.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={author.imageUrl} alt="" className="w-full h-full object-cover" />
        ) : null}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2">
          <span className="font-semibold text-sm">{author.name ?? "Deleted user"}</span>
          <span className="text-xs text-zinc-500">{formatTime(message._creationTime)}</span>
        </div>
        <div className="text-sm whitespace-pre-wrap break-words">
          {tombstoned ? (
            <span className="italic text-zinc-400">This message was deleted</span>
          ) : (
            message.text
          )}
        </div>
        {!tombstoned && (
          <ReactionBar
            messageId={message._id}
            reactions={reactions ?? []}
            currentUserId={currentUserId}
          />
        )}
      </div>
      {isOwn && !tombstoned && (
        <button
          className="opacity-0 group-hover:opacity-100 text-xs text-red-500 hover:underline self-start"
          onClick={() => {
            if (confirm("Delete this message?")) {
              void deleteMessage({ messageId: message._id });
            }
          }}
        >
          Delete
        </button>
      )}
    </div>
  );
}
