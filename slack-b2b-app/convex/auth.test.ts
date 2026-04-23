/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { PaywallError, assertFeature, getFeatures } from "./auth";
import {
  FEATURE_BASIC_MESSAGING,
  FEATURE_PRIVATE_CHANNELS,
  FEATURE_PUBLIC_CHANNELS,
  FEATURE_UNLIMITED_MESSAGE_HISTORY,
  PLAN_FREE,
  PLAN_PRO,
} from "./billing";

describe("PaywallError", () => {
  test("carries featureKey and has name PaywallError", () => {
    const err = new PaywallError(FEATURE_UNLIMITED_MESSAGE_HISTORY);
    expect(err.name).toBe("PaywallError");
    expect(err.featureKey).toBe(FEATURE_UNLIMITED_MESSAGE_HISTORY);
    expect(err.message).toMatch(/unlimited_message_history/);
    expect(err).toBeInstanceOf(Error);
  });
});

describe("assertFeature", () => {
  test("succeeds silently for Pro org on a Pro feature", () => {
    expect(() =>
      assertFeature({ planKey: PLAN_PRO }, FEATURE_PRIVATE_CHANNELS),
    ).not.toThrow();
  });

  test("throws PaywallError for Free org on a Pro feature", () => {
    expect(() =>
      assertFeature({ planKey: PLAN_FREE }, FEATURE_PRIVATE_CHANNELS),
    ).toThrow(PaywallError);
    try {
      assertFeature({ planKey: PLAN_FREE }, FEATURE_PRIVATE_CHANNELS);
    } catch (e) {
      expect((e as PaywallError).featureKey).toBe(FEATURE_PRIVATE_CHANNELS);
    }
  });

  test("succeeds for Free org on a Free feature", () => {
    expect(() =>
      assertFeature({ planKey: PLAN_FREE }, FEATURE_PUBLIC_CHANNELS),
    ).not.toThrow();
  });

  test("treats undefined planKey as Free", () => {
    expect(() =>
      assertFeature({ planKey: undefined }, FEATURE_BASIC_MESSAGING),
    ).not.toThrow();
    expect(() =>
      assertFeature({ planKey: undefined }, FEATURE_PRIVATE_CHANNELS),
    ).toThrow(PaywallError);
  });

  test("treats unknown planKey as Free (defensive)", () => {
    expect(() =>
      assertFeature(
        { planKey: "enterprise_future_plan" },
        FEATURE_BASIC_MESSAGING,
      ),
    ).not.toThrow();
    expect(() =>
      assertFeature(
        { planKey: "enterprise_future_plan" },
        FEATURE_PRIVATE_CHANNELS,
      ),
    ).toThrow(PaywallError);
  });
});

describe("getFeatures", () => {
  test("returns all four features for Pro", () => {
    const features = getFeatures({ planKey: PLAN_PRO });
    expect(features).toEqual(
      expect.arrayContaining([
        FEATURE_PUBLIC_CHANNELS,
        FEATURE_BASIC_MESSAGING,
        FEATURE_PRIVATE_CHANNELS,
        FEATURE_UNLIMITED_MESSAGE_HISTORY,
      ]),
    );
    expect(features).toHaveLength(4);
  });

  test("returns two Free features for Free", () => {
    const features = getFeatures({ planKey: PLAN_FREE });
    expect(features).toEqual([
      FEATURE_PUBLIC_CHANNELS,
      FEATURE_BASIC_MESSAGING,
    ]);
  });

  test("returns Free features for undefined planKey", () => {
    expect(getFeatures({ planKey: undefined })).toEqual([
      FEATURE_PUBLIC_CHANNELS,
      FEATURE_BASIC_MESSAGING,
    ]);
  });
});
