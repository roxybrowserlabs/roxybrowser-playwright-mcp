import type { HumanController } from "./human/types.js";
import type { ProtocolLocatorAdapter } from "./protocol/adapter.js";
import { parseSelectorChain } from "./selectors.js";
import type { Locator } from "./types/api.js";
import type {
  ClickOptions,
  FillOptions,
  GetByRoleOptions,
  GetByTextOptions,
  HoverOptions,
  PressOptions,
  TypeOptions
} from "./types/options.js";

export class RoxyLocator implements Locator {
  constructor(
    private readonly adapter: ProtocolLocatorAdapter,
    private readonly humanController: HumanController
  ) {}

  locator(selector: string): Locator {
    const chain = parseSelectorChain(selector);
    const [first, ...rest] = chain;
    if (!first) {
      throw new Error("Selector must not be empty.");
    }
    let adapter = this.adapter.locator(first);
    for (const part of rest) {
      adapter = adapter.locator(part);
    }
    return new RoxyLocator(adapter, this.humanController);
  }

  getByText(text: string | RegExp, options?: GetByTextOptions): Locator {
    const selector = {
      strategy: "text" as const,
      value: text instanceof RegExp ? text.source : text,
      ...(options?.exact !== undefined ? { exact: options.exact } : {}),
      ...(text instanceof RegExp
        ? {
            isRegex: true,
            regexFlags: text.flags
          }
        : {})
    };

    return new RoxyLocator(
      this.adapter.locator(selector),
      this.humanController
    );
  }

  getByRole(role: string, options?: GetByRoleOptions): Locator {
    const selector = {
      strategy: "role" as const,
      value: role,
      ...(options?.exact !== undefined ? { exact: options.exact } : {}),
      ...(typeof options?.name === "string" ? { name: options.name } : {}),
      ...(options?.name instanceof RegExp
        ? {
            name: options.name.source,
            nameIsRegex: true,
            nameRegexFlags: options.name.flags
          }
        : {})
    };

    return new RoxyLocator(
      this.adapter.locator(selector),
      this.humanController
    );
  }

  first(): Locator {
    return new RoxyLocator(this.adapter.first(), this.humanController);
  }

  last(): Locator {
    return new RoxyLocator(this.adapter.last(), this.humanController);
  }

  nth(index: number): Locator {
    return new RoxyLocator(this.adapter.nth(index), this.humanController);
  }

  async click(options?: ClickOptions): Promise<void> {
    await this.humanController.click(this.adapter, options);
  }

  async hover(options?: HoverOptions): Promise<void> {
    await this.humanController.hover(this.adapter, options);
  }

  async fill(value: string, options?: FillOptions): Promise<void> {
    await this.humanController.fill(this.adapter, value, options);
  }

  async type(value: string, options?: TypeOptions): Promise<void> {
    await this.humanController.type(this.adapter, value, options);
  }

  async press(key: string, options?: PressOptions): Promise<void> {
    await this.humanController.press(this.adapter, key, options);
  }

  async textContent(): Promise<string | null> {
    return this.adapter.textContent();
  }

  async isVisible(): Promise<boolean> {
    return this.adapter.isVisible();
  }
}
