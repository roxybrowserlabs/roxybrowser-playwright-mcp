import type {
  WaitForSelectorOptions,
  WaitForSelectorState
} from "./types/options.js";

const SUPPORTED_WAIT_FOR_SELECTOR_STATES = new Set<WaitForSelectorState>([
  "attached",
  "detached",
  "hidden",
  "visible"
]);

export interface NormalizedWaitForSelectorOptions {
  state: WaitForSelectorState;
  timeout: number;
}

export function normalizeWaitForSelectorOptions(
  options: WaitForSelectorOptions,
  defaultTimeout: number
): NormalizedWaitForSelectorOptions {
  if ("visibility" in (options as Record<string, unknown>)) {
    throw new Error("options.visibility is not supported, did you mean options.state?");
  }

  if ("waitFor" in options && options.waitFor !== undefined && options.waitFor !== "visible") {
    throw new Error("options.waitFor is not supported, did you mean options.state?");
  }

  const candidateState = options.state ?? options.waitFor ?? "visible";
  if (!SUPPORTED_WAIT_FOR_SELECTOR_STATES.has(candidateState as WaitForSelectorState)) {
    throw new Error("state: expected one of (attached|detached|visible|hidden)");
  }

  return {
    state: candidateState as WaitForSelectorState,
    timeout: options.timeout ?? defaultTimeout
  };
}
