// Deterministic, injectable RNG utilities for humanization algorithms.
//
// The humanized motion/typing math takes an `rng: () => number` so tests can pin randomness
// (via `createSeededRng`) while runtime uses `defaultRng` (Math.random). Keeping randomness
// injected — rather than calling Math.random() inside the algorithm — is what makes the
// curve/timing generators unit-testable and deterministic.

export type Rng = () => number;

/**
 * mulberry32 — a tiny, fast, seedable PRNG. Same seed → identical sequence.
 * Returns floats in [0, 1).
 */
export function createSeededRng(seed: number): Rng {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Runtime default RNG. Non-deterministic; not used by unit tests. */
export const defaultRng: Rng = () => Math.random();
