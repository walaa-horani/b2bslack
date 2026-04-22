"use client";

import { useEffect } from "react";
import { useOrganization, useOrganizationList } from "@clerk/nextjs";

/**
 * Keeps the Clerk "active organization" in lock-step with the URL slug.
 *
 * - User navigates to /beta while /acme is active → flip the active org to beta.
 * - If the user is not a member of /beta, the proxy has already redirected
 *   them, so in practice this only runs on slugs the user is in.
 */
export function SyncActiveOrg({ slug }: { slug: string }) {
  const { organization } = useOrganization();
  const { setActive, userMemberships, isLoaded } = useOrganizationList({
    userMemberships: { infinite: false },
  });

  useEffect(() => {
    if (!isLoaded) return;
    if (organization?.slug === slug) return;
    const match = userMemberships.data?.find(
      (m) => m.organization.slug === slug,
    );
    if (!match) return;
    void setActive({ organization: match.organization.id });
  }, [isLoaded, organization?.slug, slug, userMemberships.data, setActive]);

  return null;
}
