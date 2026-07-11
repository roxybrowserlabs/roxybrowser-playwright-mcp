import type {
  HumanProfileName,
  HumanizationOptions,
  ResolvedHumanizationOptions
} from "./types.js";

const PROFILE_DEFAULTS: Record<HumanProfileName, ResolvedHumanizationOptions> = {
  cautious: {
    profile: "cautious",
    moveJitterMs: 220,
    clickHoldMs: 260,
    scrollStepPx: 120,
    typingDelayMs: 240,
    typingVarianceMs: 90,
    hoverBeforeClickMs: 680
  },
  balanced: {
    profile: "balanced",
    moveJitterMs: 140,
    clickHoldMs: 180,
    scrollStepPx: 180,
    typingDelayMs: 140,
    typingVarianceMs: 55,
    hoverBeforeClickMs: 380
  },
  fast: {
    profile: "fast",
    moveJitterMs: 80,
    clickHoldMs: 120,
    scrollStepPx: 240,
    typingDelayMs: 85,
    typingVarianceMs: 30,
    hoverBeforeClickMs: 180
  }
};

export function resolveHumanizationOptions(
  options?: HumanizationOptions,
  base?: ResolvedHumanizationOptions
): ResolvedHumanizationOptions {
  const profileName = options?.profile ?? base?.profile ?? "balanced";
  const profile = PROFILE_DEFAULTS[profileName];

  return {
    profile: profileName,
    moveJitterMs: options?.moveJitterMs ?? base?.moveJitterMs ?? profile.moveJitterMs,
    clickHoldMs: options?.clickHoldMs ?? base?.clickHoldMs ?? profile.clickHoldMs,
    scrollStepPx: options?.scrollStepPx ?? base?.scrollStepPx ?? profile.scrollStepPx,
    typingDelayMs: options?.typingDelayMs ?? base?.typingDelayMs ?? profile.typingDelayMs,
    typingVarianceMs:
      options?.typingVarianceMs ?? base?.typingVarianceMs ?? profile.typingVarianceMs,
    hoverBeforeClickMs:
      options?.hoverBeforeClickMs ?? base?.hoverBeforeClickMs ?? profile.hoverBeforeClickMs
  };
}

export function jitter(ms: number): number {
  return Math.round(ms * (0.8 + Math.random() * 0.4));
}
