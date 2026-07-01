import { describe, expect, it } from "vitest";
import { createSeededRng, defaultRng } from "../../../src/human/random.js";

describe("createSeededRng", () => {
  it("produces an identical sequence for the same seed", () => {
    const a = createSeededRng(42);
    const b = createSeededRng(42);
    const seqA = Array.from({ length: 10 }, () => a());
    const seqB = Array.from({ length: 10 }, () => b());
    expect(seqA).toEqual(seqB);
  });

  it("produces different sequences for different seeds", () => {
    const a = createSeededRng(1);
    const b = createSeededRng(2);
    const seqA = Array.from({ length: 10 }, () => a());
    const seqB = Array.from({ length: 10 }, () => b());
    expect(seqA).not.toEqual(seqB);
  });

  it("returns floats in [0, 1)", () => {
    const rng = createSeededRng(123);
    for (let i = 0; i < 1000; i += 1) {
      const value = rng();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it("advances state across calls (not constant)", () => {
    const rng = createSeededRng(7);
    const first = rng();
    const second = rng();
    expect(first).not.toBe(second);
  });
});

describe("defaultRng", () => {
  it("returns floats in [0, 1)", () => {
    for (let i = 0; i < 100; i += 1) {
      const value = defaultRng();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});
