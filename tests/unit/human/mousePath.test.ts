import { describe, expect, it } from "vitest";
import { buildHumanMousePath, type Vec2 } from "../../../src/human/mousePath.js";
import { createSeededRng } from "../../../src/human/random.js";

const start: Vec2 = { x: 0, y: 0 };
const end: Vec2 = { x: 300, y: 200 };
const opts = { stepPx: 24, durationMs: 140 };

function perpendicularDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  return Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / len;
}

describe("buildHumanMousePath", () => {
  it("always ends exactly at the target point (many seeds)", () => {
    for (let seed = 0; seed < 50; seed += 1) {
      const path = buildHumanMousePath(start, end, opts, createSeededRng(seed));
      const last = path[path.length - 1]!;
      expect(last.x).toBe(end.x);
      expect(last.y).toBe(end.y);
    }
  });

  it("is deterministic for the same seed", () => {
    const a = buildHumanMousePath(start, end, opts, createSeededRng(11));
    const b = buildHumanMousePath(start, end, opts, createSeededRng(11));
    expect(a).toEqual(b);
  });

  it("varies bow direction across seeds", () => {
    const a = { x: 0, y: 0 };
    const b = { x: 200, y: 0 };
    const signs = new Set<number>();
    for (let seed = 0; seed < 40; seed += 1) {
      const path = buildHumanMousePath(a, b, { stepPx: 24, durationMs: 100 }, createSeededRng(seed));
      const mid = path[Math.floor(path.length / 2)]!;
      // For a horizontal move, the bow shows up as a non-zero y offset; capture its sign.
      if (Math.abs(mid.y) > 0.001) {
        signs.add(Math.sign(mid.y));
      }
    }
    expect(signs.has(1)).toBe(true);
    expect(signs.has(-1)).toBe(true);
  });

  it("keeps perpendicular deviation within the bow cap plus tremor", () => {
    const dist = Math.hypot(end.x - start.x, end.y - start.y);
    const maxBow = Math.min(24, dist * 0.08);
    for (let seed = 0; seed < 30; seed += 1) {
      const path = buildHumanMousePath(start, end, opts, createSeededRng(seed));
      for (const p of path) {
        // Deviation from the straight start->end line. Overshoot points extend along the
        // line (small perpendicular component), so the bow cap + tremor bounds all points.
        expect(perpendicularDistance(p, start, end)).toBeLessThanOrEqual(maxBow + 4);
      }
    }
  });

  it("emits ceil(distance/stepPx) steps when overshoot is disabled", () => {
    // Constant rng > OVERSHOOT_PROBABILITY (and >= 0.5) disables overshoot.
    const path = buildHumanMousePath(start, end, opts, () => 0.9);
    const dist = Math.hypot(end.x - start.x, end.y - start.y);
    expect(path).toHaveLength(Math.ceil(dist / opts.stepPx));
  });

  it("distributes delays summing to roughly durationMs, all non-negative", () => {
    const path = buildHumanMousePath(start, end, opts, createSeededRng(4));
    const sum = path.reduce((total, p) => total + p.delayMs, 0);
    for (const p of path) {
      expect(p.delayMs).toBeGreaterThanOrEqual(0);
    }
    expect(sum).toBeGreaterThan(opts.durationMs * 0.75);
    expect(sum).toBeLessThan(opts.durationMs * 1.25);
  });

  it("overshoots past the target then settles exactly on it", () => {
    // Constant small rng forces overshoot (< OVERSHOOT_PROBABILITY) on a long-enough move.
    const path = buildHumanMousePath(start, end, opts, () => 0.01);
    const dist = Math.hypot(end.x - start.x, end.y - start.y);
    // Some point must travel beyond the target distance (overshoot), and the last is exact.
    const maxProjected = Math.max(
      ...path.map((p) => (p.x * (end.x - start.x) + p.y * (end.y - start.y)) / dist)
    );
    expect(maxProjected).toBeGreaterThan(dist);
    const last = path[path.length - 1]!;
    expect(last.x).toBe(end.x);
    expect(last.y).toBe(end.y);
  });

  it("returns a single exact point for zero distance", () => {
    const path = buildHumanMousePath({ x: 50, y: 60 }, { x: 50, y: 60 }, opts, createSeededRng(1));
    expect(path).toEqual([{ x: 50, y: 60, delayMs: 0 }]);
  });

  it("emits one exact step for a sub-stepPx distance", () => {
    const path = buildHumanMousePath({ x: 0, y: 0 }, { x: 5, y: 0 }, { stepPx: 24, durationMs: 40 }, createSeededRng(2));
    expect(path).toHaveLength(1);
    expect(path[0]!.x).toBe(5);
    expect(path[0]!.y).toBe(0);
  });

  it("produces zero delays when durationMs is 0, endpoint still exact", () => {
    const path = buildHumanMousePath(start, end, { stepPx: 24, durationMs: 0 }, createSeededRng(1));
    for (const p of path) {
      expect(p.delayMs).toBe(0);
    }
    const last = path[path.length - 1]!;
    expect(last.x).toBe(end.x);
    expect(last.y).toBe(end.y);
  });

  it("never yields NaN or Infinity", () => {
    for (let seed = 0; seed < 30; seed += 1) {
      const path = buildHumanMousePath(start, end, opts, createSeededRng(seed));
      for (const p of path) {
        expect(Number.isFinite(p.x)).toBe(true);
        expect(Number.isFinite(p.y)).toBe(true);
        expect(Number.isFinite(p.delayMs)).toBe(true);
      }
    }
  });
});
