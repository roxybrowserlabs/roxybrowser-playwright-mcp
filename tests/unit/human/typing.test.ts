import { describe, expect, it } from "vitest";
import { buildTypingDelays, buildTypingPlan } from "../../../src/human/typing.js";
import { createSeededRng } from "../../../src/human/random.js";

describe("buildTypingDelays", () => {
  it("returns one delay per iterated code point (surrogate-safe)", () => {
    const rng = createSeededRng(1);
    expect(buildTypingDelays("a😀b", { delayMs: 100, varianceMs: 20 }, rng)).toHaveLength(3);
  });

  it("returns [] for an empty string", () => {
    expect(buildTypingDelays("", { delayMs: 100, varianceMs: 20 }, createSeededRng(1))).toEqual([]);
  });

  it("is deterministic for the same seed and differs across seeds", () => {
    const opts = { delayMs: 140, varianceMs: 55 };
    const a = buildTypingDelays("hello world", opts, createSeededRng(9));
    const b = buildTypingDelays("hello world", opts, createSeededRng(9));
    const c = buildTypingDelays("hello world", opts, createSeededRng(10));
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it("keeps every delay within [delayMs - varianceMs, delayMs + varianceMs] and >= 0", () => {
    const delayMs = 140;
    const varianceMs = 55;
    const delays = buildTypingDelays("the quick brown fox", { delayMs, varianceMs }, createSeededRng(3));
    for (const d of delays) {
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeGreaterThanOrEqual(delayMs - varianceMs);
      expect(d).toBeLessThanOrEqual(delayMs + varianceMs);
    }
  });

  it("clamps negative results to 0 when variance exceeds the base delay", () => {
    const delays = buildTypingDelays("xxxx", { delayMs: 5, varianceMs: 50 }, () => 0);
    // rng()=0 -> offset = (0*2-1)*50 = -50 -> 5 - 50 < 0 -> clamped to 0
    expect(delays).toEqual([0, 0, 0, 0]);
  });

  it("produces a flat delay when varianceMs is 0 (no behavior change)", () => {
    const delays = buildTypingDelays("abcd", { delayMs: 77, varianceMs: 0 }, createSeededRng(1));
    expect(delays).toEqual([77, 77, 77, 77]);
  });

  it("has a mean near the base delay over a long string", () => {
    const delayMs = 120;
    const text = "a".repeat(400);
    const delays = buildTypingDelays(text, { delayMs, varianceMs: 60 }, createSeededRng(5));
    const mean = delays.reduce((sum, d) => sum + d, 0) / delays.length;
    expect(Math.abs(mean - delayMs)).toBeLessThan(10);
  });
});

describe("buildTypingPlan", () => {
  it("builds plain character actions when mistakes are not sampled", () => {
    const plan = buildTypingPlan(
      "abc",
      {
        delayMs: 100,
        varianceMs: 0,
        mistakeRate: 0.5,
        correctionDelayMs: 300,
        correctionVarianceMs: 0
      },
      () => 0.99
    );

    expect(plan).toEqual([
      { type: "char", value: "a", delay: 100 },
      { type: "char", value: "b", delay: 100 },
      { type: "char", value: "c", delay: 100 }
    ]);
  });

  it("inserts a wrong character, pause, backspace, then the intended character when a mistake is sampled", () => {
    const plan = buildTypingPlan(
      "a",
      {
        delayMs: 100,
        varianceMs: 0,
        mistakeRate: 1,
        correctionDelayMs: 300,
        correctionVarianceMs: 0
      },
      () => 0
    );

    expect(plan).toEqual([
      { type: "char", value: "s", delay: 100 },
      { type: "pause", delay: 300 },
      { type: "backspace", delay: 100 },
      { type: "char", value: "a", delay: 100 }
    ]);
  });

  it("preserves the final intended text after applying typo corrections", () => {
    const plan = buildTypingPlan(
      "hello",
      {
        delayMs: 80,
        varianceMs: 0,
        mistakeRate: 1,
        correctionDelayMs: 200,
        correctionVarianceMs: 0
      },
      () => 0
    );
    const finalText = applyTypingPlan(plan);

    expect(finalText).toBe("hello");
    expect(plan.some((action) => action.type === "backspace")).toBe(true);
  });
});

function applyTypingPlan(plan: ReturnType<typeof buildTypingPlan>): string {
  let text = "";
  for (const action of plan) {
    if (action.type === "char") {
      text += action.value;
    } else if (action.type === "backspace") {
      text = text.slice(0, -1);
    }
  }
  return text;
}
