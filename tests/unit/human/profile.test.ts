import { describe, expect, it } from "vitest";
import { resolveHumanizationOptions } from "../../../src/human/profile.js";

describe("resolveHumanizationOptions", () => {
  it("uses balanced defaults by default", () => {
    const result = resolveHumanizationOptions();

    expect(result).toEqual({
      enabled: false,
      profile: "balanced",
      moveJitterMs: 16,
      clickHoldMs: 60,
      scrollStepPx: 280,
      typingDelayMs: 95,
      typingVarianceMs: 35,
      hoverBeforeClickMs: 110
    });
  });

  it("enables humanization only when explicitly requested", () => {
    const result = resolveHumanizationOptions({
      enabled: true,
      profile: "fast"
    });

    expect(result).toEqual({
      enabled: true,
      profile: "fast",
      moveJitterMs: 8,
      clickHoldMs: 30,
      scrollStepPx: 360,
      typingDelayMs: 45,
      typingVarianceMs: 20,
      hoverBeforeClickMs: 45
    });
  });

  it("prefers explicit options over inherited defaults", () => {
    const result = resolveHumanizationOptions(
      {
        profile: "fast",
        typingDelayMs: 10,
        enabled: false
      },
      {
        enabled: true,
        profile: "cautious",
        moveJitterMs: 1,
        clickHoldMs: 2,
        scrollStepPx: 3,
        typingDelayMs: 4,
        typingVarianceMs: 5,
        hoverBeforeClickMs: 6
      }
    );

    expect(result).toEqual({
      enabled: false,
      profile: "fast",
      moveJitterMs: 1,
      clickHoldMs: 2,
      scrollStepPx: 3,
      typingDelayMs: 10,
      typingVarianceMs: 5,
      hoverBeforeClickMs: 6
    });
  });

  it("falls back to profile defaults when base is missing fields", () => {
    const result = resolveHumanizationOptions(
      {
        profile: "cautious"
      },
      {
        enabled: true,
        profile: "balanced",
        moveJitterMs: 10,
        clickHoldMs: 20,
        scrollStepPx: 30,
        typingDelayMs: 40,
        typingVarianceMs: 50,
        hoverBeforeClickMs: 60
      }
    );

    expect(result.profile).toBe("cautious");
    expect(result.moveJitterMs).toBe(10);
    expect(result.clickHoldMs).toBe(20);
    expect(result.scrollStepPx).toBe(30);
    expect(result.typingDelayMs).toBe(40);
    expect(result.typingVarianceMs).toBe(50);
    expect(result.hoverBeforeClickMs).toBe(60);
  });
});
