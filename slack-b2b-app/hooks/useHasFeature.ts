"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";

/**
 * Returns whether the workspace's plan grants `featureKey`.
 * Returns `undefined` while the underlying query is loading.
 *
 * Sources from `workspace.getOverview` (which reads `organizations.planKey`,
 * mirrored from Clerk Billing via the `/clerk-webhook` endpoint — see
 * convex/http.ts). This hook is safe to call without a workspace slug (pass
 * empty string) — the query will be skipped and the hook returns undefined.
 */
export function useHasFeature(
  workspaceSlug: string,
  featureKey: string,
): boolean | undefined {
  const overview = useQuery(
    api.workspace.getOverview,
    workspaceSlug ? { slug: workspaceSlug } : "skip",
  );
  if (overview === undefined) return undefined;
  return overview.features.includes(featureKey);
}
