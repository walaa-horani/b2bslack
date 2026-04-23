"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

export function InviteToChannelModal({
  open,
  workspaceSlug,
  channelId,
  onClose,
}: {
  open: boolean;
  workspaceSlug: string;
  channelId: Id<"channels">;
  onClose: () => void;
}) {
  const members = useQuery(
    api.workspace.listMembers,
    open ? { workspaceSlug } : "skip",
  );
  const existingIds = useQuery(
    api.channels.listChannelMembers,
    open ? { channelId } : "skip",
  );
  const invite = useMutation(api.channels.invite);
  const [search, setSearch] = useState("");
  const [addingId, setAddingId] = useState<string | null>(null);

  const candidates = useMemo(() => {
    if (!members || !existingIds) return [];
    const set = new Set(existingIds);
    const q = search.trim().toLowerCase();
    return members
      .filter((m) => !set.has(m.user._id))
      .filter((m) => {
        if (!q) return true;
        const n = (m.user.name ?? "").toLowerCase();
        const e = m.user.email.toLowerCase();
        return n.includes(q) || e.includes(q);
      });
  }, [members, existingIds, search]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-20 bg-black/40 flex items-center justify-center">
      <div className="bg-white dark:bg-zinc-950 rounded-lg shadow-xl p-6 w-full max-w-md flex flex-col gap-3 max-h-[80vh]">
        <h2 className="text-lg font-semibold">Add people</h2>
        <input
          autoFocus
          type="text"
          placeholder="Search by name or email…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="rounded border px-3 py-2 text-sm dark:bg-zinc-900"
        />
        <div className="flex-1 overflow-y-auto">
          {members === undefined || existingIds === undefined ? (
            <div className="text-sm text-zinc-400">Loading…</div>
          ) : candidates.length === 0 ? (
            <div className="text-sm text-zinc-400">No one else to add.</div>
          ) : (
            <ul className="flex flex-col gap-1">
              {candidates.map((m) => (
                <li
                  key={m.user._id}
                  className="flex items-center justify-between border rounded px-3 py-2"
                >
                  <div>
                    <div className="text-sm font-medium">
                      {m.user.name ?? m.user.email}
                    </div>
                    <div className="text-xs text-zinc-500">{m.user.email}</div>
                  </div>
                  <button
                    disabled={addingId === m.user._id}
                    onClick={async () => {
                      setAddingId(m.user._id);
                      try {
                        await invite({ channelId, userId: m.user._id });
                      } catch (err: unknown) {
                        const msg = err instanceof Error ? err.message : "Failed";
                        alert(msg);
                      } finally {
                        setAddingId(null);
                      }
                    }}
                    className="text-sm px-3 py-1 rounded bg-foreground text-background disabled:opacity-50"
                  >
                    {addingId === m.user._id ? "Adding…" : "Add"}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="flex justify-end">
          <button
            type="button"
            className="px-3 py-1 rounded text-sm"
            onClick={onClose}
          >
            Done
          </button>
        </div>
        {/* unused hint to silence workspaceSlug-unused lint */}
        <span className="hidden">{workspaceSlug}</span>
      </div>
    </div>
  );
}
