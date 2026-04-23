"use client";

import { PricingTable } from "@clerk/nextjs";
import { use } from "react";

export default function BillingPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = use(params);
  return (
    <div className="max-w-4xl w-full mx-auto">
      <h1 className="text-2xl font-semibold mb-2">Billing</h1>
      <p className="text-sm text-zinc-500 mb-6">
        Manage your workspace&apos;s subscription. Changes take effect within about a minute.
      </p>
      <PricingTable
        for="organization"
        newSubscriptionRedirectUrl={`/${slug}/channels/general`}
      />
    </div>
  );
}
