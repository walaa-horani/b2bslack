"use client";

import { useEffect, useRef } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

const HEARTBEAT_MS = 3000;
const BLUR_GRACE_MS = 1000;

export function useTypingHeartbeat(channelId: Id<"channels">) {
  const heartbeat = useMutation(api.typing.heartbeat);
  const stop = useMutation(api.typing.stop);
  const lastSentRef = useRef(0);
  const blurTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (blurTimerRef.current) clearTimeout(blurTimerRef.current);
      void stop({ channelId });
    };
  }, [channelId, stop]);

  return {
    onKey: () => {
      const now = Date.now();
      if (now - lastSentRef.current < HEARTBEAT_MS) return;
      lastSentRef.current = now;
      void heartbeat({ channelId });
    },
    onSend: () => {
      lastSentRef.current = 0;
      void stop({ channelId });
    },
    onBlur: () => {
      if (blurTimerRef.current) clearTimeout(blurTimerRef.current);
      blurTimerRef.current = setTimeout(() => {
        void stop({ channelId });
      }, BLUR_GRACE_MS);
    },
    onFocus: () => {
      if (blurTimerRef.current) {
        clearTimeout(blurTimerRef.current);
        blurTimerRef.current = null;
      }
    },
  };
}
