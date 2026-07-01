// Per-keystroke timing for humanized typing.
//
// Activates the `typingVarianceMs` profile field (previously unused): instead of one flat
// delay for every character, each keystroke gets an independently sampled dwell around the
// base delay. Pure and rng-injected so the distribution is unit-testable and deterministic.

import type { Rng } from "./random.js";

export interface TypingDelayOptions {
  /** Base per-character delay in ms. */
  delayMs: number;
  /** Maximum ± deviation applied per character. 0 disables variance (flat delay). */
  varianceMs: number;
}

export interface TypingPlanOptions extends TypingDelayOptions {
  /** Internal per-character typo chance. Kept profile-owned, not exposed as public API. */
  mistakeRate: number;
  /** Pause after a wrong character before Backspace. */
  correctionDelayMs: number;
  /** Maximum ± deviation applied to correction pauses. */
  correctionVarianceMs: number;
}

export type TypingAction =
  | { type: "char"; value: string; delay: number }
  | { type: "pause"; delay: number }
  | { type: "backspace"; delay: number };

/**
 * Build a per-character delay schedule for `text`.
 *
 * - One entry per iterated code point (matches the backends' `for..of text` loop, so
 *   surrogate pairs / emoji stay aligned).
 * - Each delay lands in `[delayMs - varianceMs, delayMs + varianceMs]`, clamped to `>= 0`.
 * - `varianceMs <= 0` → every delay equals `round(delayMs)` (byte-flat; no behavior change
 *   when variance is disabled).
 * - Empty string → `[]`.
 */
export function buildTypingDelays(
  text: string,
  options: TypingDelayOptions,
  rng: Rng
): number[] {
  const { delayMs, varianceMs } = options;
  return [...text].map(() => {
    return sampleDelay(delayMs, varianceMs, rng);
  });
}

export function buildTypingPlan(
  text: string,
  options: TypingPlanOptions,
  rng: Rng
): TypingAction[] {
  const actions: TypingAction[] = [];
  const mistakeRate = Math.max(0, Math.min(1, options.mistakeRate));

  for (const character of text) {
    const intendedDelay = sampleDelay(options.delayMs, options.varianceMs, rng);
    if (mistakeRate > 0 && shouldMistype(character) && rng() < mistakeRate) {
      actions.push({
        type: "char",
        value: wrongCharacterFor(character, rng),
        delay: intendedDelay
      });
      actions.push({
        type: "pause",
        delay: sampleDelay(options.correctionDelayMs, options.correctionVarianceMs, rng)
      });
      actions.push({
        type: "backspace",
        delay: sampleDelay(options.delayMs, options.varianceMs, rng)
      });
    }
    actions.push({
      type: "char",
      value: character,
      delay: intendedDelay
    });
  }

  return actions;
}

function sampleDelay(delayMs: number, varianceMs: number, rng: Rng): number {
  const flat = Math.max(0, Math.round(delayMs));
  if (varianceMs <= 0) {
    return flat;
  }
  const offset = (rng() * 2 - 1) * varianceMs;
  return Math.max(0, Math.round(delayMs + offset));
}

function shouldMistype(character: string): boolean {
  return character.trim().length > 0;
}

function wrongCharacterFor(character: string, rng: Rng): string {
  const candidates = nearbyCharacters(character);
  return candidates[Math.floor(rng() * candidates.length)] ?? "x";
}

function nearbyCharacters(character: string): string[] {
  const lower = character.toLowerCase();
  const neighbors: Record<string, string[]> = {
    a: ["s", "q", "w"],
    b: ["v", "g", "h", "n"],
    c: ["x", "d", "f", "v"],
    d: ["s", "e", "r", "f", "c", "x"],
    e: ["w", "s", "d", "r"],
    f: ["d", "r", "t", "g", "v", "c"],
    g: ["f", "t", "y", "h", "b", "v"],
    h: ["g", "y", "u", "j", "n", "b"],
    i: ["u", "j", "k", "o"],
    j: ["h", "u", "i", "k", "m", "n"],
    k: ["j", "i", "o", "l", "m"],
    l: ["k", "o", "p"],
    m: ["n", "j", "k"],
    n: ["b", "h", "j", "m"],
    o: ["i", "k", "l", "p"],
    p: ["o", "l"],
    q: ["w", "a"],
    r: ["e", "d", "f", "t"],
    s: ["a", "w", "e", "d", "x", "z"],
    t: ["r", "f", "g", "y"],
    u: ["y", "h", "j", "i"],
    v: ["c", "f", "g", "b"],
    w: ["q", "a", "s", "e"],
    x: ["z", "s", "d", "c"],
    y: ["t", "g", "h", "u"],
    z: ["a", "s", "x"]
  };
  const candidates = neighbors[lower] ?? ["a", "s", "d", "f", "j", "k", "l"];
  if (character === lower) {
    return candidates;
  }
  return candidates.map((candidate) => candidate.toUpperCase());
}
