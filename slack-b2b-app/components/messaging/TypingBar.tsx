"use client";

import { useEffect, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

function summarize(names: string[]): string {
  if (names.length === 0) return "";
  if (names.length === 1) return `${names[0]} is typing…`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`;
  if (names.length === 3)
    return `${names[0]}, ${names[1]}, and 1 other are typing…`;
  return "Several people are typing…";
}

export function TypingBar({ channelId }: { channelId: Id<"channels"> }) {
  const typers = useQuery(api.typing.listForChannel, { channelId }) ?? [];
  const [, setTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const now = Date.now();
  const live = typers.filter((t) => t.expiresAt > now);
  const text = summarize(live.map((t) => t.name));

  return (
    <div className="h-5 px-4 text-xs text-zinc-500 italic">
      {text || " "}
    </div>
  );
}
