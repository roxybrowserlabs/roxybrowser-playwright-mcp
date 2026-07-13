import type { FillOptions, PressOptions } from "../types/options.js";
import { resolveHumanizationOptions } from "./profile.js";
import { defaultRng } from "./random.js";
import { buildTypingPlan } from "./typing.js";
import type {
  HumanActionTarget,
  HumanActionOptions,
  HumanController,
  HumanizedClickOptions,
  HumanizedHoverOptions,
  HumanizedTypeOptions,
  ResolvedHumanizationOptions
} from "./types.js";

export class DefaultHumanController implements HumanController {
  private actionQueue = Promise.resolve();

  constructor(private readonly defaults: ResolvedHumanizationOptions) {}

  async click(target: HumanActionTarget, options?: HumanizedClickOptions & HumanActionOptions): Promise<void> {
    const defaults = this.resolveDefaults(options);
    const action = async () => {
      await target.click({
        ...this.withHumanMove(options, defaults),
        delay: options?.delay ?? defaults.clickHoldMs
      });
    };
    if (options?.__roxyBeforeActionRetry) {
      await action();
      return;
    }
    await this.enqueue(action);
  }

  async hover(target: HumanActionTarget, options?: HumanizedHoverOptions & HumanActionOptions): Promise<void> {
    const defaults = this.resolveDefaults(options);
    await target.hover(this.withHumanMove(options, defaults));
  }

  async fill(
    target: HumanActionTarget,
    value: string,
    options?: FillOptions & HumanActionOptions
  ): Promise<void> {
    await target.fill(value, options);
  }

  async type(
    target: HumanActionTarget,
    value: string,
    options?: HumanizedTypeOptions & HumanActionOptions
  ): Promise<void> {
    const defaults = this.resolveDefaults(options);
    await this.typeText(target, value, options, defaults);
  }

  async press(
    target: HumanActionTarget,
    key: string,
    options?: PressOptions & HumanActionOptions
  ): Promise<void> {
    const defaults = this.resolveDefaults(options);
    await target.press(key, {
      ...options,
      delay: options?.delay ?? defaults.typingDelayMs
    });
  }

  private resolveDefaults(options?: HumanActionOptions): ResolvedHumanizationOptions {
    return resolveHumanizationOptions(options?.human, this.defaults);
  }

  private async typeText(
    target: HumanActionTarget,
    value: string,
    options: (HumanizedTypeOptions | (FillOptions & HumanActionOptions)) | undefined,
    defaults: ResolvedHumanizationOptions
  ): Promise<void> {
    const delay =
      options && "delay" in options && typeof options.delay === "number"
        ? options.delay
        : defaults.typingDelayMs;
    const variance = defaults.typingVarianceMs;
    const typingBehavior = typingBehaviorForProfile(defaults.profile);
    await target.type(value, {
      ...options,
      delay,
      __roxyTypingPlan: buildTypingPlan(
        value,
        {
          delayMs: delay,
          varianceMs: variance,
          mistakeRate: typingBehavior.mistakeRate,
          correctionDelayMs: typingBehavior.correctionDelayMs,
          correctionVarianceMs: typingBehavior.correctionVarianceMs
        },
        defaultRng
      ),
      // Forward per-keystroke variance so the backend jitters each character's dwell.
      // Mirrors the __roxyHumanMove convention; omitted when variance is disabled.
      ...(variance > 0 ? { __roxyTypeVariance: variance } : {})
    } as HumanizedTypeOptions);
  }

  private async enqueue<TResult>(action: () => Promise<TResult>): Promise<TResult> {
    const run = this.actionQueue.then(action, action);
    this.actionQueue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private withHumanMove<TOptions extends (HumanizedClickOptions | HumanizedHoverOptions) | undefined>(
    options: TOptions,
    defaults: ResolvedHumanizationOptions
  ): TOptions {
    if (options?.__roxyBeforeActionRetry) {
      return options;
    }
    return {
      ...(options ?? {}),
      __roxyHumanMove: {
        durationMs: defaults.moveJitterMs,
        stepPx: 24
      }
    } as TOptions;
  }
}

function delay(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, timeoutMs);
  });
}

function typingBehaviorForProfile(profile: ResolvedHumanizationOptions["profile"]): {
  mistakeRate: number;
  correctionDelayMs: number;
  correctionVarianceMs: number;
} {
  switch (profile) {
    case "cautious":
      return {
        mistakeRate: 0.006,
        correctionDelayMs: 360,
        correctionVarianceMs: 120
      };
    case "fast":
      return {
        mistakeRate: 0.018,
        correctionDelayMs: 190,
        correctionVarianceMs: 70
      };
    case "balanced":
    default:
      return {
        mistakeRate: 0.012,
        correctionDelayMs: 260,
        correctionVarianceMs: 90
      };
  }
}
