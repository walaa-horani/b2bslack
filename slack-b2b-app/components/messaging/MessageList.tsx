"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { usePaginatedQuery, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { MessageRow } from "@/components/messaging/MessageRow";

const PAGE_SIZE = 30;
const NEAR_TOP_PX = 200;

export function MessageList({ channelId }: { channelId: Id<"channels"> }) {
  const me = useQuery(api.workspace.whoami, {});
  const { results, status, loadMore } = usePaginatedQuery(
    api.messages.list,
    { channelId },
    { initialNumItems: PAGE_SIZE },
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  const prevScrollHeightRef = useRef<number | null>(null);
  const [atBottom, setAtBottom] = useState(true);

  // Reverse for display: newest at bottom.
  const displayed = results.slice().reverse();

  const firstLoadDone = useRef(false);
  useLayoutEffect(() => {
    if (!scrollRef.current) return;
    if (status === "LoadingFirstPage") return;
    if (!firstLoadDone.current && displayed.length > 0) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      firstLoadDone.current = true;
      return;
    }
    if (prevScrollHeightRef.current !== null) {
      const diff =
        scrollRef.current.scrollHeight - prevScrollHeightRef.current;
      scrollRef.current.scrollTop += diff;
      prevScrollHeightRef.current = null;
      return;
    }
    if (atBottom) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [displayed.length, status, atBottom]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;

    const nearBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setAtBottom(nearBottom);

    if (
      el.scrollTop < NEAR_TOP_PX &&
      status === "CanLoadMore"
    ) {
      prevScrollHeightRef.current = el.scrollHeight;
      loadMore(PAGE_SIZE);
    }
  };

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      className="flex-1 overflow-y-auto min-h-0 py-2"
    >
      {status === "LoadingFirstPage" ? (
        <div className="text-center text-zinc-400 text-sm py-8">
          Loading messages…
        </div>
      ) : displayed.length === 0 ? (
        <div className="text-center text-zinc-400 text-sm py-8">
          No messages yet. Say hi!
        </div>
      ) : (
        <>
          {status === "LoadingMore" && (
            <div className="text-center text-zinc-400 text-xs py-1">
              Loading older…
            </div>
          )}
          {displayed.map((row) => (
            <MessageRow
              key={row.message._id}
              message={row.message}
              author={row.author}
              isOwn={!!me && row.author._id === me._id}
            />
          ))}
        </>
      )}
      {!atBottom && (
        <button
          className="fixed bottom-24 right-10 bg-blue-600 text-white text-xs rounded-full px-3 py-1 shadow"
          onClick={() => {
            if (scrollRef.current) {
              scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
            }
          }}
        >
          New messages ↓
        </button>
      )}
    </div>
  );
}
