"use client";

import Link from "next/link";
import { use } from "react";
import { useQuery } from "convex/react";
import { OrganizationSwitcher, UserButton } from "@clerk/nextjs";
import { api } from "@/convex/_generated/api";

export default function WorkspaceHome({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = use(params);
  const overview = useQuery(api.workspace.getOverview, { slug });

  return (
    <div className="flex flex-col flex-1">
      <header className="flex items-center justify-between border-b px-6 py-3">
        <div className="flex items-center gap-3">
          <OrganizationSwitcher
            afterSelectOrganizationUrl="/:slug"
            afterCreateOrganizationUrl="/:slug"
            hidePersonal
          />
        </div>
        <div className="flex items-center gap-3">
          <Link href={`/${slug}/members`} className="text-sm underline">
            Manage members
          </Link>
          <UserButton />
        </div>
      </header>
      <main className="flex-1 flex flex-col items-center justify-center gap-3 p-8">
        {overview === undefined ? (
          <p className="text-zinc-500">Loading workspace…</p>
        ) : (
          <>
            <h1 className="text-3xl font-bold">Welcome, {overview.userName}</h1>
            <p className="text-zinc-600">
              You&apos;re{" "}
              {overview.role === "org:admin" ? "an admin" : "a member"} of{" "}
              <span className="font-medium">{overview.orgName}</span>.
            </p>
          </>
        )}
      </main>
    </div>
  );
}
