import { describe, expect, it } from "vitest";
import { resolveHumanizationOptions } from "../../../src/human/profile.js";

describe("resolveHumanizationOptions", () => {
  it("uses balanced defaults by default", () => {
    const result = resolveHumanizationOptions();

    expect(result).toEqual({
      profile: "balanced",
      moveJitterMs: 140,
      clickHoldMs: 180,
      scrollStepPx: 180,
      typingDelayMs: 140,
      typingVarianceMs: 55,
      hoverBeforeClickMs: 380
    });
  });

  it("keeps humanization enabled when selecting another profile", () => {
    const result = resolveHumanizationOptions({
      profile: "fast"
    });

    expect(result).toEqual({
      profile: "fast",
      moveJitterMs: 80,
      clickHoldMs: 120,
      scrollStepPx: 240,
      typingDelayMs: 85,
      typingVarianceMs: 30,
      hoverBeforeClickMs: 180
    });
  });

  it("prefers explicit options over inherited defaults", () => {
    const result = resolveHumanizationOptions(
      {
        profile: "fast",
        typingDelayMs: 10
      },
      {
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
