// Humanized mouse-move path generation for click/hover.
//
// Replaces the old deterministic ease-out + fixed-direction sin bow with a randomized cubic
// Bézier: random bow direction & magnitude, ease-in-out spatial cadence, bounded per-point
// tremor, and probabilistic overshoot-and-correct. Endpoints are pinned EXACT to start/end so
// the final landing coordinate never drifts. Pure and rng-injected → deterministic unit tests.
//
// Protocol-agnostic: deals only in {x, y} and numbers, never CDP/BiDi types. Both backends
// share this one implementation (CDP↔BiDi parity).

import type { Rng } from "./random.js";

export interface Vec2 {
  x: number;
  y: number;
}

export interface HumanMovePoint {
  x: number;
  y: number;
  /** Delay to wait AFTER moving to this point, in ms. */
  delayMs: number;
}

export interface HumanMousePathOptions {
  /** Approximate pixels per step; controls how many intermediate points are emitted. */
  stepPx: number;
  /** Total time budget for the move, distributed across the emitted points. */
  durationMs: number;
}

const MAX_BOW_PX = 24;
const BOW_DISTANCE_FACTOR = 0.08;
const TREMOR_PX = 2;
const OVERSHOOT_PROBABILITY = 0.35;
const MAX_OVERSHOOT_PX = 16;
const OVERSHOOT_DISTANCE_FACTOR = 0.06;

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

function cubicBezier(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const mt = 1 - t;
  return mt * mt * mt * p0 + 3 * mt * mt * t * p1 + 3 * mt * t * t * p2 + t * t * t * p3;
}

/**
 * Build a humanized path of intermediate points from `start` to `end` (excluding `start`,
 * including `end`). The last point is ALWAYS exactly `end`. Returns a single point at `end`
 * for a zero/tiny distance.
 */
export function buildHumanMousePath(
  start: Vec2,
  end: Vec2,
  options: HumanMousePathOptions,
  rng: Rng
): HumanMovePoint[] {
  const stepPx = Math.max(1, options.stepPx);
  const durationMs = Math.max(0, options.durationMs);
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const distance = Math.hypot(dx, dy);

  if (distance === 0) {
    return [{ x: end.x, y: end.y, delayMs: 0 }];
  }

  const steps = Math.max(1, Math.ceil(distance / stepPx));

  // Perpendicular unit vector (for the bow) and forward unit vector (for overshoot).
  const nx = -dy / distance;
  const ny = dx / distance;
  const fx = dx / distance;
  const fy = dy / distance;

  const bowSign = rng() < 0.5 ? -1 : 1;
  const maxBow = Math.min(MAX_BOW_PX, distance * BOW_DISTANCE_FACTOR);
  const bowMag = maxBow * (0.5 + rng() * 0.5) * bowSign;

  const canOvershoot = distance > stepPx * 3;
  const overshoot = canOvershoot && rng() < OVERSHOOT_PROBABILITY;
  const overshootPx = overshoot
    ? Math.min(MAX_OVERSHOOT_PX, distance * OVERSHOOT_DISTANCE_FACTOR) * (0.5 + rng() * 0.5)
    : 0;

  // The Bézier travels to `segEnd`; when overshooting, that is a point past `end`.
  const segEnd: Vec2 = overshoot
    ? { x: end.x + fx * overshootPx, y: end.y + fy * overshootPx }
    : { x: end.x, y: end.y };

  const c1: Vec2 = {
    x: start.x + (segEnd.x - start.x) / 3 + nx * bowMag,
    y: start.y + (segEnd.y - start.y) / 3 + ny * bowMag
  };
  const c2: Vec2 = {
    x: start.x + ((segEnd.x - start.x) * 2) / 3 + nx * bowMag,
    y: start.y + ((segEnd.y - start.y) * 2) / 3 + ny * bowMag
  };

  const settleSteps = overshoot ? Math.max(2, Math.min(4, Math.round(overshootPx / stepPx))) : 0;
  const totalSteps = steps + settleSteps;
  const perStep = durationMs / totalSteps;

  const points: HumanMovePoint[] = [];

  for (let index = 1; index <= steps; index += 1) {
    const eased = easeInOut(index / steps);
    let x = cubicBezier(start.x, c1.x, c2.x, segEnd.x, eased);
    let y = cubicBezier(start.y, c1.y, c2.y, segEnd.y, eased);
    // Tremor on intermediate points only; the true endpoint is pinned below.
    if (!(index === steps && !overshoot)) {
      x += (rng() * 2 - 1) * TREMOR_PX;
      y += (rng() * 2 - 1) * TREMOR_PX;
    }
    points.push({ x, y, delayMs: sampleDelay(perStep, rng) });
  }

  // Overshoot correction: ease back from segEnd to the exact target.
  for (let index = 1; index <= settleSteps; index += 1) {
    const t = index / settleSteps;
    const eased = easeInOut(t);
    let x = segEnd.x + (end.x - segEnd.x) * eased;
    let y = segEnd.y + (end.y - segEnd.y) * eased;
    if (index !== settleSteps) {
      x += (rng() * 2 - 1) * TREMOR_PX;
      y += (rng() * 2 - 1) * TREMOR_PX;
    }
    points.push({ x, y, delayMs: sampleDelay(perStep, rng) });
  }

  // Pin the final point EXACTLY to the target (no tremor, no bezier rounding).
  const last = points[points.length - 1];
  if (last) {
    last.x = end.x;
    last.y = end.y;
  }

  normalizeDelays(points, durationMs);
  return points;
}

function sampleDelay(base: number, rng: Rng): number {
  if (base <= 0) {
    return 0;
  }
  return base * (0.85 + rng() * 0.3);
}

function normalizeDelays(points: HumanMovePoint[], durationMs: number): void {
  if (durationMs <= 0 || points.length === 0) {
    for (const point of points) {
      point.delayMs = 0;
    }
    return;
  }

  const sampledTotal = points.reduce((total, point) => total + point.delayMs, 0);
  if (sampledTotal <= 0) {
    const perPoint = durationMs / points.length;
    for (const point of points) {
      point.delayMs = perPoint;
    }
    return;
  }

  const scale = durationMs / sampledTotal;
  let normalizedTotal = 0;
  for (const point of points) {
    point.delayMs *= scale;
    normalizedTotal += point.delayMs;
  }
  points[points.length - 1]!.delayMs += durationMs - normalizedTotal;
}
