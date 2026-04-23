"use client";

import { useQuery } from "convex/react";
import { useRouter } from "next/navigation";
import { use, useEffect } from "react";
import { api } from "@/convex/_generated/api";

export default function SettingsLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = use(params);
  const router = useRouter();
  const overview = useQuery(api.workspace.getOverview, { slug });

  useEffect(() => {
    if (overview && overview.role !== "org:admin") {
      router.replace(`/${slug}`);
    }
  }, [overview, slug, router]);

  if (overview === undefined) {
    return (
      <div className="flex-1 flex items-center justify-center text-zinc-400">
        Loading…
      </div>
    );
  }
  if (overview.role !== "org:admin") {
    return (
      <div className="flex-1 flex items-center justify-center text-zinc-400">
        Redirecting…
      </div>
    );
  }
  return <div className="flex flex-col flex-1 p-6 overflow-auto">{children}</div>;
}
