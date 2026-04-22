"use client";

import { useEffect } from "react";
import { useMutation } from "convex/react";
import { useAuth } from "@clerk/nextjs";
import { api } from "@/convex/_generated/api";

/**
 * Mounted in the root layout. When the user signs in, calls the idempotent
 * `users.ensureUser` mutation once to guarantee a Convex user row exists
 * before any tenant-scoped query runs.
 */
export function SyncUser() {
  const { isSignedIn, isLoaded } = useAuth();
  const ensureUser = useMutation(api.users.ensureUser);

  useEffect(() => {
    if (!isLoaded || !isSignedIn) return;
    void ensureUser();
  }, [isLoaded, isSignedIn, ensureUser]);

  return null;
}
