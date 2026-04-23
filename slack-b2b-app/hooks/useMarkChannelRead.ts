"use client";

import { useEffect, useRef } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

const THROTTLE_MS = 2000;

export function useMarkChannelRead(
  channelId: Id<"channels">,
  atBottom: boolean,
  newestCreationTime: number | undefined,
) {
  const markRead = useMutation(api.reads.markRead);
  const lastSentRef = useRef(0);

  useEffect(() => {
    lastSentRef.current = Date.now();
    void markRead({ channelId });
  }, [channelId, markRead]);

  useEffect(() => {
    if (!atBottom || !newestCreationTime) return;
    const now = Date.now();
    if (now - lastSentRef.current < THROTTLE_MS) return;
    lastSentRef.current = now;
    void markRead({ channelId });
  }, [atBottom, newestCreationTime, channelId, markRead]);
}
