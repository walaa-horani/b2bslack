"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { useQuery } from "convex/react";
import { OrganizationSwitcher, UserButton } from "@clerk/nextjs";
import { api } from "@/convex/_generated/api";
import { CreateChannelModal } from "@/components/messaging/CreateChannelModal";
import { BrowseChannelsModal } from "@/components/messaging/BrowseChannelsModal";
import { useHasFeature } from "@/hooks/useHasFeature";

export function WorkspaceSidebar({ slug }: { slug: string }) {
  const channels = useQuery(api.channels.listMine, { workspaceSlug: slug });
  const pathname = usePathname();
  const [createOpen, setCreateOpen] = useState(false);
  const [browseOpen, setBrowseOpen] = useState(false);
  const hasUnlimited = useHasFeature(slug, "unlimited_message_history");

  return (
    <aside className="flex flex-col w-64 flex-shrink-0 border-r bg-zinc-100 dark:bg-zinc-900">
      <div className="p-3 border-b">
        <OrganizationSwitcher
          afterSelectOrganizationUrl="/:slug"
          afterCreateOrganizationUrl="/:slug"
          hidePersonal
        />
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
            Channels
          </span>
          <button
            className="w-5 h-5 rounded hover:bg-zinc-200 dark:hover:bg-zinc-800 text-zinc-500"
            onClick={() => setCreateOpen(true)}
            title="Create channel"
            aria-label="Create channel"
          >
            +
          </button>
        </div>

        {channels === undefined ? (
          <div className="text-xs text-zinc-400">Loading…</div>
        ) : channels.length === 0 ? (
          <div className="text-xs text-zinc-400">No channels yet.</div>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {channels.map((ch) => {
              const href = `/${slug}/channels/${ch.slug}`;
              const isActive = pathname === href;
              return (
                <li key={ch._id}>
                  <Link
                    href={href}
                    className={`block px-2 py-1 rounded text-sm truncate ${
                      isActive
                        ? "bg-zinc-200 dark:bg-zinc-800 font-medium"
                        : "hover:bg-zinc-200 dark:hover:bg-zinc-800"
                    }`}
                  >
                    {ch.isPrivate ? "🔒" : "#"} {ch.slug}
                  </Link>
                </li>
              );
            })}
          </ul>
        )}

        <button
          className="mt-3 text-xs text-zinc-500 hover:underline"
          onClick={() => setBrowseOpen(true)}
        >
          Browse channels…
        </button>
      </div>

      {hasUnlimited === false && (
        <Link
          href={`/${slug}/settings/billing`}
          className="mx-3 mb-2 text-xs text-center rounded border px-2 py-1 bg-gradient-to-r from-blue-50 to-purple-50 hover:from-blue-100 hover:to-purple-100 dark:from-blue-950 dark:to-purple-950"
        >
          ⚡ Upgrade to Pro
        </Link>
      )}

      <div className="p-3 border-t flex items-center justify-between">
        <UserButton />
        <Link href={`/${slug}/members`} className="text-xs underline text-zinc-500">
          Members
        </Link>
      </div>

      <CreateChannelModal
        open={createOpen}
        workspaceSlug={slug}
        onClose={() => setCreateOpen(false)}
      />
      <BrowseChannelsModal
        open={browseOpen}
        workspaceSlug={slug}
        onClose={() => setBrowseOpen(false)}
      />
    </aside>
  );
}
