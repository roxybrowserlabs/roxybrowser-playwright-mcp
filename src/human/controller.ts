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
import { CURSOR_VISUALIZATION_INSTALL_SOURCE } from "./bubbleCursor.js";

export class DefaultHumanController implements HumanController {
  private actionQueue = Promise.resolve();

  constructor(private readonly defaults: ResolvedHumanizationOptions) {}

  async click(target: HumanActionTarget, options?: ClickOptions): Promise<void> {
    const defaults = this.resolveDefaults(options);
    await this.ensureVisualization(target);
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

  async hover(target: HumanActionTarget, options?: HoverOptions): Promise<void> {
    const defaults = this.resolveDefaults(options);
    await this.ensureVisualization(target);
    await target.hover(this.withHumanMove(options, defaults));
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
    await this.typeText(target, value, options, defaults);
  }

  async press(
    target: HumanActionTarget,
    key: string,
    options?: PressOptions
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

  private async ensureVisualization(target: HumanActionTarget): Promise<void> {
    const evaluatableTarget = target as HumanActionTarget & {
      evaluate?: (expression: string, arg?: unknown, isFunction?: boolean) => Promise<unknown>;
    };
    if (typeof evaluatableTarget.evaluate !== "function") {
      return;
    }
    await evaluatableTarget.evaluate(CURSOR_VISUALIZATION_INSTALL_SOURCE, undefined, false);
  }

  private async typeText(
    target: HumanActionTarget,
    value: string,
    options: TypeOptions | FillOptions | undefined,
    defaults: ResolvedHumanizationOptions
  ): Promise<void> {
    const delay =
      options && "delay" in options && typeof options.delay === "number"
        ? options.delay
        : defaults.typingDelayMs;
    await target.type(value, {
      ...options,
      delay
    } as TypeOptions);
  }

  private async enqueue<TResult>(action: () => Promise<TResult>): Promise<TResult> {
    const run = this.actionQueue.then(action, action);
    this.actionQueue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private withHumanMove<TOptions extends (ClickOptions | HoverOptions) | undefined>(
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
