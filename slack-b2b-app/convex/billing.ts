/**
 * Plan + feature keys as configured in the Clerk Dashboard.
 * These strings are forever — do NOT rename after users subscribe.
 */

export const PLAN_FREE = "free_org";
export const PLAN_PRO = "pro";

export const FEATURE_PUBLIC_CHANNELS = "public_channels";
export const FEATURE_BASIC_MESSAGING = "basic_messaging";
export const FEATURE_PRIVATE_CHANNELS = "private_channels";
export const FEATURE_UNLIMITED_MESSAGE_HISTORY = "unlimited_message_history";

/** The hard cap on messages returned by `messages.list` for Free-plan channels. */
export const FREE_MESSAGE_HISTORY_CAP = 10_000;

/**
 * Plan → features map. Must stay in sync with the plan/feature configuration
 * in the Clerk dashboard. An org with an unknown or missing planKey is treated
 * as Free.
 */
const FEATURES_BY_PLAN: Record<string, string[]> = {
  [PLAN_FREE]: [FEATURE_PUBLIC_CHANNELS, FEATURE_BASIC_MESSAGING],
  [PLAN_PRO]: [
    FEATURE_PUBLIC_CHANNELS,
    FEATURE_BASIC_MESSAGING,
    FEATURE_PRIVATE_CHANNELS,
    FEATURE_UNLIMITED_MESSAGE_HISTORY,
  ],
};

export function featuresForPlan(planKey: string | null | undefined): string[] {
  if (planKey && FEATURES_BY_PLAN[planKey]) return FEATURES_BY_PLAN[planKey];
  return FEATURES_BY_PLAN[PLAN_FREE];
}

export function hasFeature(
  org: { planKey?: string | null },
  featureKey: string,
): boolean {
  return featuresForPlan(org.planKey).includes(featureKey);
}
