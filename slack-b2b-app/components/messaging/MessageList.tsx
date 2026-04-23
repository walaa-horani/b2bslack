"use client";

import { useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { usePaginatedQuery, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { MessageRow } from "@/components/messaging/MessageRow";
import { useMarkChannelRead } from "@/hooks/useMarkChannelRead";

const PAGE_SIZE = 30;
const NEAR_TOP_PX = 200;

export function MessageList({ channelId }: { channelId: Id<"channels"> }) {
  const me = useQuery(api.workspace.whoami, {});
  const { results, status, loadMore } = usePaginatedQuery(
    api.messages.list,
    { channelId },
    { initialNumItems: PAGE_SIZE },
  );
  const historyStatus = useQuery(api.messages.historyStatus, { channelId });
  const params = useParams<{ slug: string }>();

  const scrollRef = useRef<HTMLDivElement>(null);
  const prevScrollHeightRef = useRef<number | null>(null);
  const [atBottom, setAtBottom] = useState(true);

  // Reverse for display: newest at bottom.
  const displayed = results.slice().reverse();

  const newestCreationTime = displayed.length > 0
    ? displayed[displayed.length - 1].message._creationTime
    : undefined;
  useMarkChannelRead(channelId, atBottom, newestCreationTime);

  const messageIds = displayed.map((r) => r.message._id).slice(-300);
  const reactionsByMessage =
    useQuery(api.reactions.listForMessages, { messageIds }) ?? {};

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
      {status === "Exhausted" && historyStatus?.cappedByPlan && (
        <div className="mx-4 my-4 p-4 border border-dashed rounded text-center">
          <div className="text-sm font-medium mb-1">
            You&apos;ve reached your 10,000-message history.
          </div>
          <div className="text-xs text-zinc-500 mb-3">
            Upgrade to Pro to see older messages.
          </div>
          <Link
            href={`/${params.slug}/settings/billing`}
            className="text-sm underline text-blue-600"
          >
            Upgrade to Pro →
          </Link>
        </div>
      )}
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
              reactions={reactionsByMessage[row.message._id]}
              currentUserId={me?._id ?? null}
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
