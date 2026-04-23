"use client";

import { useState } from "react";

export function ChannelHeader({
  name,
  slug,
  memberCount,
  isProtected,
  isAdmin,
  onDelete,
}: {
  name: string;
  slug: string;
  memberCount: number;
  isProtected: boolean;
  isAdmin: boolean;
  onDelete: () => Promise<void>;
}) {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <header className="flex items-center justify-between px-4 py-2 border-b bg-white dark:bg-zinc-950">
      <div>
        <h1 className="font-semibold">
          <span className="text-zinc-400">#</span> {name}
        </h1>
        <div className="text-xs text-zinc-500">
          {memberCount} member{memberCount === 1 ? "" : "s"}
        </div>
      </div>
      {isAdmin && !isProtected && (
        <div className="relative">
          <button
            className="w-8 h-8 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800"
            onClick={() => setMenuOpen((v) => !v)}
            aria-label="Channel menu"
          >
            ⋯
          </button>
          {menuOpen && (
            <div className="absolute right-0 mt-1 bg-white dark:bg-zinc-950 border rounded shadow-md py-1 min-w-[160px] z-10">
              <button
                className="w-full text-left px-3 py-1 text-sm text-red-600 hover:bg-red-50 dark:hover:bg-red-900/30"
                onClick={() => {
                  setMenuOpen(false);
                  void onDelete();
                }}
              >
                Delete channel
              </button>
            </div>
          )}
        </div>
      )}
    </header>
  );
}
