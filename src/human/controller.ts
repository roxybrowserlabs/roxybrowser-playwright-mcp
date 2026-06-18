import type {
  ClickOptions,
  FillOptions,
  HoverOptions,
  PressOptions,
  TypeOptions
} from "../types/options.js";
import { resolveHumanizationOptions } from "./profile.js";
import type {
  HumanActionTarget,
  HumanActionOptions,
  HumanController,
  ResolvedHumanizationOptions
} from "./types.js";

export class DefaultHumanController implements HumanController {
  private actionQueue = Promise.resolve();

  constructor(private readonly defaults: ResolvedHumanizationOptions) {}

  async click(target: HumanActionTarget, options?: ClickOptions): Promise<void> {
    const defaults = this.resolveDefaults(options);
    if (!defaults.enabled) {
      await target.click(options);
      return;
    }
    await this.enqueue(async () => {
      await this.hover(target, options);
      if (defaults.hoverBeforeClickMs > 0) {
        await delay(defaults.hoverBeforeClickMs);
      }
      await target.click({
        ...options,
        delay: options?.delay ?? defaults.clickHoldMs
      });
    });
  }

  async hover(target: HumanActionTarget, options?: HoverOptions): Promise<void> {
    await target.hover(options);
  }

  async fill(
    target: HumanActionTarget,
    value: string,
    options?: FillOptions
  ): Promise<void> {
    await target.fill(value, options);
  }

  async type(
    target: HumanActionTarget,
    value: string,
    options?: TypeOptions
  ): Promise<void> {
    const defaults = this.resolveDefaults(options);
    if (!defaults.enabled) {
      await target.type(value, options);
      return;
    }
    await target.type(value, {
      ...options,
      delay: options?.delay ?? defaults.typingDelayMs
    });
  }

  async press(
    target: HumanActionTarget,
    key: string,
    options?: PressOptions
  ): Promise<void> {
    const defaults = this.resolveDefaults(options);
    if (!defaults.enabled) {
      await target.press(key, options);
      return;
    }
    await target.press(key, {
      ...options,
      delay: options?.delay ?? defaults.typingDelayMs
    });
  }

  private resolveDefaults(options?: HumanActionOptions): ResolvedHumanizationOptions {
    return resolveHumanizationOptions(options?.human, this.defaults);
  }

  private async enqueue<TResult>(action: () => Promise<TResult>): Promise<TResult> {
    const run = this.actionQueue.then(action, action);
    this.actionQueue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }
}

function delay(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, timeoutMs);
  });
}
