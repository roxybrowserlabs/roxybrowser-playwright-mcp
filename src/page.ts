import { DefaultHumanController } from "./human/controller.js";
import { RoxyLocator } from "./locator.js";
import type { ResolvedHumanizationOptions } from "./human/types.js";
import type { ProtocolPageAdapter } from "./protocol/adapter.js";
import type { Locator, Page } from "./types/api.js";
import type {
  ClickOptions,
  FillOptions,
  GetByRoleOptions,
  GetByTextOptions,
  HoverOptions,
  PageGotoOptions,
  PressOptions,
  TypeOptions
} from "./types/options.js";

export class RoxyPage implements Page {
  private readonly humanController: DefaultHumanController;

  constructor(
    private readonly adapter: ProtocolPageAdapter,
    humanDefaults: ResolvedHumanizationOptions
  ) {
    this.humanController = new DefaultHumanController(humanDefaults);
  }

  async goto(url: string, options?: PageGotoOptions): Promise<void> {
    await this.adapter.goto(url, options);
  }

  async title(): Promise<string> {
    return this.adapter.title();
  }

  async content(): Promise<string> {
    return this.adapter.content();
  }

  async setContent(html: string): Promise<void> {
    await this.adapter.setContent(html);
  }

  async evaluate<TResult>(expression: string, arg?: unknown): Promise<TResult> {
    return this.adapter.evaluate<TResult>(expression, arg);
  }

  async waitForLoadState(state?: PageGotoOptions["waitUntil"]): Promise<void> {
    await this.adapter.waitForLoadState(state);
  }

  locator(selector: string): Locator {
    return new RoxyLocator(
      this.adapter.locator({
        strategy: "css",
        value: selector
      }),
      this.humanController
    );
  }

  getByText(text: string | RegExp, options?: GetByTextOptions): Locator {
    return new RoxyLocator(this.adapter.getByText(text, options), this.humanController);
  }

  getByRole(role: string, options?: GetByRoleOptions): Locator {
    return new RoxyLocator(this.adapter.getByRole(role, options), this.humanController);
  }

  async click(selector: string, options?: ClickOptions): Promise<void> {
    await this.locator(selector).click(options);
  }

  async hover(selector: string, options?: HoverOptions): Promise<void> {
    await this.locator(selector).hover(options);
  }

  async fill(selector: string, value: string, options?: FillOptions): Promise<void> {
    await this.locator(selector).fill(value, options);
  }

  async type(selector: string, value: string, options?: TypeOptions): Promise<void> {
    await this.locator(selector).type(value, options);
  }

  async press(selector: string, key: string, options?: PressOptions): Promise<void> {
    await this.locator(selector).press(key, options);
  }

  async close(): Promise<void> {
    await this.adapter.close();
  }
}

