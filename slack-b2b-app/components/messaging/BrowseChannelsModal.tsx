"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";

export function BrowseChannelsModal({
  open,
  workspaceSlug,
  onClose,
}: {
  open: boolean;
  workspaceSlug: string;
  onClose: () => void;
}) {
  const browsable = useQuery(
    api.channels.listBrowsable,
    open ? { workspaceSlug } : "skip",
  );
  const join = useMutation(api.channels.join);
  const router = useRouter();
  const [joiningId, setJoiningId] = useState<string | null>(null);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-20 bg-black/40 flex items-center justify-center">
      <div className="bg-white dark:bg-zinc-950 rounded-lg shadow-xl p-6 w-full max-w-md flex flex-col gap-3 max-h-[80vh]">
        <h2 className="text-lg font-semibold">Browse channels</h2>
        <div className="flex-1 overflow-y-auto">
          {browsable === undefined ? (
            <div className="text-sm text-zinc-400">Loading…</div>
          ) : browsable.length === 0 ? (
            <div className="text-sm text-zinc-400">
              No channels to join — you&apos;re in all of them.
            </div>
          ) : (
            <ul className="flex flex-col gap-1">
              {browsable.map((ch) => (
                <li
                  key={ch._id}
                  className="flex items-center justify-between border rounded px-3 py-2"
                >
                  <div>
                    <div className="text-sm font-medium"># {ch.slug}</div>
                    <div className="text-xs text-zinc-500">{ch.name}</div>
                  </div>
                  <button
                    disabled={joiningId === ch._id}
                    onClick={async () => {
                      setJoiningId(ch._id);
                      try {
                        await join({ channelId: ch._id });
                        onClose();
                        router.push(
                          `/${workspaceSlug}/channels/${ch.slug}`,
                        );
                      } finally {
                        setJoiningId(null);
                      }
                    }}
                    className="text-sm px-3 py-1 rounded bg-foreground text-background disabled:opacity-50"
                  >
                    {joiningId === ch._id ? "Joining…" : "Join"}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="flex justify-end">
          <button className="px-3 py-1 rounded text-sm" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
