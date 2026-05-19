import type {
  ClickOptions,
  FillOptions,
  HoverOptions,
  PressOptions,
  TypeOptions
} from "../types/options.js";
import type {
  HumanActionTarget,
  HumanController,
  ResolvedHumanizationOptions
} from "./types.js";

export class DefaultHumanController implements HumanController {
  constructor(private readonly defaults: ResolvedHumanizationOptions) {}

  async click(target: HumanActionTarget, options?: ClickOptions): Promise<void> {
    await this.hover(target, options);
    if (this.defaults.hoverBeforeClickMs > 0) {
      await delay(this.defaults.hoverBeforeClickMs);
    }
    await target.click({
      ...options,
      delay: options?.delay ?? this.defaults.clickHoldMs
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
    await target.type(value, {
      ...options,
      delay: options?.delay ?? this.defaults.typingDelayMs
    });
  }

  async press(
    target: HumanActionTarget,
    key: string,
    options?: PressOptions
  ): Promise<void> {
    await target.press(key, {
      ...options,
      delay: options?.delay ?? this.defaults.typingDelayMs
    });
  }
}

function delay(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, timeoutMs);
  });
}
