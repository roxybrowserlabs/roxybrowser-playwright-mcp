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
    await this.ensureVisualization(target);
    await target.hover(options);
  }

  async fill(
    target: HumanActionTarget,
    value: string,
    options?: FillOptions
  ): Promise<void> {
    const defaults = this.resolveDefaults(options);
    await this.prepareEditableTarget(target, options, defaults);
    await this.clearEditableTarget(target, defaults);
    await this.typeText(target, value, {
      ...(options?.human !== undefined ? { human: options.human } : {})
    }, defaults);
  }

  async type(
    target: HumanActionTarget,
    value: string,
    options?: TypeOptions
  ): Promise<void> {
    const defaults = this.resolveDefaults(options);
    await this.prepareEditableTarget(target, options, defaults);
    await this.typeText(target, value, options, defaults);
  }

  async press(
    target: HumanActionTarget,
    key: string,
    options?: PressOptions
  ): Promise<void> {
    const defaults = this.resolveDefaults(options);
    await this.prepareEditableTarget(target, options, defaults);
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
    await evaluatableTarget.evaluate(CURSOR_VISUALIZATION_INSTALL_SOURCE);
  }

  private async prepareEditableTarget(
    target: HumanActionTarget,
    options: HumanActionOptions | undefined,
    defaults: ResolvedHumanizationOptions
  ): Promise<void> {
    await this.ensureVisualization(target);
    await this.enqueue(async () => {
      await target.hover(options as HoverOptions | undefined);
      if (defaults.hoverBeforeClickMs > 0) {
        await delay(defaults.hoverBeforeClickMs);
      }
      await target.click({
        ...(options ?? {}),
        delay: defaults.clickHoldMs
      } as ClickOptions);
      await target.focus?.();
    });
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

  private async clearEditableTarget(
    target: HumanActionTarget,
    defaults: ResolvedHumanizationOptions
  ): Promise<void> {
    if (typeof target.clear === "function") {
      await target.clear();
      return;
    }
    await target.fill("", {
      human: { profile: defaults.profile }
    });
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
