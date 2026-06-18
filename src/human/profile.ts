import type {
  HumanProfileName,
  HumanizationOptions
} from "../types/options.js";
import type { ResolvedHumanizationOptions } from "./types.js";

const PROFILE_DEFAULTS: Record<HumanProfileName, ResolvedHumanizationOptions> = {
  cautious: {
    enabled: false,
    profile: "cautious",
    moveJitterMs: 28,
    clickHoldMs: 90,
    scrollStepPx: 180,
    typingDelayMs: 140,
    typingVarianceMs: 55,
    hoverBeforeClickMs: 180
  },
  balanced: {
    enabled: false,
    profile: "balanced",
    moveJitterMs: 16,
    clickHoldMs: 60,
    scrollStepPx: 280,
    typingDelayMs: 95,
    typingVarianceMs: 35,
    hoverBeforeClickMs: 110
  },
  fast: {
    enabled: false,
    profile: "fast",
    moveJitterMs: 8,
    clickHoldMs: 30,
    scrollStepPx: 360,
    typingDelayMs: 45,
    typingVarianceMs: 20,
    hoverBeforeClickMs: 45
  }
};

export function resolveHumanizationOptions(
  options?: HumanizationOptions,
  base?: ResolvedHumanizationOptions
): ResolvedHumanizationOptions {
  const profileName = options?.profile ?? base?.profile ?? "balanced";
  const profile = PROFILE_DEFAULTS[profileName];

  return {
    enabled: options?.enabled ?? base?.enabled ?? profile.enabled,
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
