import type { HumanController } from "./human/types.js";
import { resolveHumanizationOptions } from "./human/profile.js";
import type { ResolvedHumanizationOptions } from "./human/types.js";
import { RoxyElementHandle, type ElementHandleFrameResolver } from "./elementHandle.js";
import {
  createAltTextLocatorSelector,
  createLabelLocatorSelector,
  createPlaceholderLocatorSelector,
  createRoleLocatorSelector,
  createTestIdLocatorSelector,
  createTextLocatorSelector,
  createTitleLocatorSelector
} from "./locatorSelectors.js";
import type { LocatorSelector, ProtocolLocatorAdapter } from "./protocol/adapter.js";
import { parseSelectorChain } from "./selectors.js";
import type { ElementHandle, FrameLocator, Locator } from "./types/api.js";
import type {
  ClickOptions,
  FillOptions,
  GetByAltTextOptions,
  GetByLabelOptions,
  GetByPlaceholderOptions,
  GetByRoleOptions,
  GetByTextOptions,
  GetByTitleOptions,
  HoverOptions,
  PressOptions,
  SelectOptionValue,
  TypeOptions
} from "./types/options.js";

const ENTER_FRAME_SELECTOR: LocatorSelector = {
  strategy: "control",
  value: "enter-frame"
};
const DEFAULT_LOCATOR_HUMAN_DEFAULTS = resolveHumanizationOptions({ enabled: false });

type ActionOptionsLike = { force?: boolean } | undefined;

function chainLocator(
  adapter: ProtocolLocatorAdapter,
  selector: string
): ProtocolLocatorAdapter {
  const chain = parseSelectorChain(selector);
  const [first, ...rest] = chain;
  if (!first) {
    throw new Error("Selector must not be empty.");
  }

  let current = adapter.locator(first);
  for (const part of rest) {
    current = current.locator(part);
  }
  return current;
}

export class RoxyLocator implements Locator {
  private readonly selectorChain: LocatorSelector[] | null;

  constructor(
    private readonly adapter: ProtocolLocatorAdapter,
    private readonly humanController: HumanController,
    selectorChain: LocatorSelector[] | null = null,
    private readonly beforeAction?: (locator: RoxyLocator, options?: ActionOptionsLike) => Promise<void>,
    private readonly humanDefaults: ResolvedHumanizationOptions = DEFAULT_LOCATOR_HUMAN_DEFAULTS,
    private readonly frameResolver?: ElementHandleFrameResolver
  ) {
    this.selectorChain = selectorChain ? selectorChain.map((part) => ({ ...part })) : null;
  }

  _roxySelectorChain(): LocatorSelector[] | null {
    return this.selectorChain ? this.selectorChain.map((part) => ({ ...part })) : null;
  }

  locator(selector: string): Locator {
    const chain = parseSelectorChain(selector);
    return new RoxyLocator(
      chainLocator(this.adapter, selector),
      this.humanController,
      [...(this.selectorChain ?? []), ...chain],
      this.beforeAction,
      this.humanDefaults,
      this.frameResolver
    );
  }

  frameLocator(selector: string): FrameLocator {
    return this.locator(selector).contentFrame();
  }

  contentFrame(): FrameLocator {
    return new RoxyFrameLocator(
      this,
      new RoxyLocator(
        this.adapter.locator(ENTER_FRAME_SELECTOR),
        this.humanController,
        [...(this.selectorChain ?? []), ENTER_FRAME_SELECTOR],
        this.beforeAction,
        this.humanDefaults,
        this.frameResolver
      )
    );
  }

  getByText(text: string | RegExp, options?: GetByTextOptions): Locator {
    return new RoxyLocator(
      this.adapter.getByText(text, options),
      this.humanController,
      this.extendSelectorChain("getByText", text, options),
      this.beforeAction,
      this.humanDefaults,
      this.frameResolver
    );
  }

  getByAltText(text: string | RegExp, options?: GetByAltTextOptions): Locator {
    return new RoxyLocator(
      this.adapter.getByAltText(text, options),
      this.humanController,
      this.extendSelectorChain("getByAltText", text, options),
      this.beforeAction,
      this.humanDefaults,
      this.frameResolver
    );
  }

  getByLabel(text: string | RegExp, options?: GetByLabelOptions): Locator {
    return new RoxyLocator(
      this.adapter.getByLabel(text, options),
      this.humanController,
      this.extendSelectorChain("getByLabel", text, options),
      this.beforeAction,
      this.humanDefaults,
      this.frameResolver
    );
  }

  getByPlaceholder(text: string | RegExp, options?: GetByPlaceholderOptions): Locator {
    return new RoxyLocator(
      this.adapter.getByPlaceholder(text, options),
      this.humanController,
      this.extendSelectorChain("getByPlaceholder", text, options),
      this.beforeAction,
      this.humanDefaults,
      this.frameResolver
    );
  }

  getByTestId(testId: string | RegExp): Locator {
    return new RoxyLocator(
      this.adapter.getByTestId(testId),
      this.humanController,
      this.extendSelectorChain("getByTestId", testId),
      this.beforeAction,
      this.humanDefaults,
      this.frameResolver
    );
  }

  getByRole(role: string, options?: GetByRoleOptions): Locator {
    return new RoxyLocator(
      this.adapter.getByRole(role, options),
      this.humanController,
      this.extendSelectorChain("getByRole", role, options),
      this.beforeAction,
      this.humanDefaults,
      this.frameResolver
    );
  }

  getByTitle(text: string | RegExp, options?: GetByTitleOptions): Locator {
    return new RoxyLocator(
      this.adapter.getByTitle(text, options),
      this.humanController,
      this.extendSelectorChain("getByTitle", text, options),
      this.beforeAction,
      this.humanDefaults,
      this.frameResolver
    );
  }

  first(): Locator {
    return new RoxyLocator(this.adapter.first(), this.humanController, this.selectorChain, this.beforeAction, this.humanDefaults, this.frameResolver);
  }

  last(): Locator {
    return new RoxyLocator(this.adapter.last(), this.humanController, this.selectorChain, this.beforeAction, this.humanDefaults, this.frameResolver);
  }

  nth(index: number): Locator {
    return new RoxyLocator(this.adapter.nth(index), this.humanController, this.selectorChain, this.beforeAction, this.humanDefaults, this.frameResolver);
  }

  async dblclick(options?: ClickOptions): Promise<void> {
    await this.beforeAction?.(this, options);
    await this.adapter.dblclick(options);
  }

  async check(options?: ClickOptions): Promise<void> {
    await this.beforeAction?.(this, options);
    await this.adapter.check(options);
  }

  async click(options?: ClickOptions): Promise<void> {
    await this.beforeAction?.(this, options);
    await this.humanController.click(this.adapter, options);
  }

  async hover(options?: HoverOptions): Promise<void> {
    await this.beforeAction?.(this, options);
    await this.humanController.hover(this.adapter, options);
  }

  async fill(value: string, options?: FillOptions): Promise<void> {
    await this.beforeAction?.(this, options);
    await this.humanController.fill(this.adapter, value, options);
  }

  async type(value: string, options?: TypeOptions): Promise<void> {
    await this.beforeAction?.(this, undefined);
    await this.humanController.type(this.adapter, value, options);
  }

  async press(key: string, options?: PressOptions): Promise<void> {
    await this.beforeAction?.(this, undefined);
    await this.humanController.press(this.adapter, key, options);
  }

  async focus(): Promise<void> {
    await this.adapter.focus();
  }

  async getAttribute(name: string): Promise<string | null> {
    return this.adapter.getAttribute(name);
  }

  async innerHTML(): Promise<string> {
    return this.adapter.innerHTML();
  }

  async innerText(): Promise<string> {
    return this.adapter.innerText();
  }

  async inputValue(): Promise<string> {
    return this.adapter.inputValue();
  }

  async isChecked(): Promise<boolean> {
    return this.adapter.isChecked();
  }

  async isDisabled(): Promise<boolean> {
    return this.adapter.isDisabled();
  }

  async isEditable(): Promise<boolean> {
    return this.adapter.isEditable();
  }

  async isEnabled(): Promise<boolean> {
    return this.adapter.isEnabled();
  }

  async isHidden(): Promise<boolean> {
    return this.adapter.isHidden();
  }

  async textContent(): Promise<string | null> {
    return this.adapter.textContent();
  }

  async uncheck(options?: ClickOptions): Promise<void> {
    await this.beforeAction?.(this, options);
    await this.adapter.uncheck(options);
  }

  async selectOption(
    values: string | SelectOptionValue | Array<string | SelectOptionValue>
  ): Promise<string[]> {
    await this.beforeAction?.(this, undefined);
    return this.adapter.selectOption(values);
  }

  async isVisible(): Promise<boolean> {
    return this.adapter.isVisible();
  }

  async elementHandle(options: { timeout?: number } = {}): Promise<ElementHandle> {
    void options;
    return new RoxyElementHandle(await this.adapter.elementHandle(), this.humanDefaults, this.frameResolver);
  }

  async elementHandles(): Promise<ElementHandle[]> {
    const handles = await this.adapter.elementHandles();
    return handles.map((handle) => new RoxyElementHandle(handle, this.humanDefaults, this.frameResolver));
  }

  private extendSelectorChain(
    kind:
      | "getByText"
      | "getByAltText"
      | "getByLabel"
      | "getByPlaceholder"
      | "getByTestId"
      | "getByRole"
      | "getByTitle",
    value: string | RegExp,
    options?: GetByTextOptions | GetByAltTextOptions | GetByLabelOptions | GetByPlaceholderOptions | GetByRoleOptions | GetByTitleOptions
  ): LocatorSelector[] | null {
    const current = this.selectorChain ?? [];
    switch (kind) {
      case "getByText":
        return [...current, createTextLocatorSelector(value, options as GetByTextOptions | undefined)];
      case "getByAltText":
        return [...current, createAltTextLocatorSelector(value, options as GetByAltTextOptions | undefined)];
      case "getByLabel":
        return [...current, createLabelLocatorSelector(value, options as GetByLabelOptions | undefined)];
      case "getByPlaceholder":
        return [
          ...current,
          createPlaceholderLocatorSelector(value, options as GetByPlaceholderOptions | undefined)
        ];
      case "getByTestId":
        return [...current, createTestIdLocatorSelector(value)];
      case "getByRole":
        return [
          ...current,
          createRoleLocatorSelector(String(value), options as GetByRoleOptions | undefined)
        ];
      case "getByTitle":
        return [...current, createTitleLocatorSelector(value, options as GetByTitleOptions | undefined)];
    }
  }
}

export class RoxyFrameLocator implements FrameLocator {
  constructor(
    private readonly ownerLocator: RoxyLocator,
    private readonly contentLocator: RoxyLocator
  ) {}

  first(): FrameLocator {
    return this.ownerLocator.first().contentFrame();
  }

  last(): FrameLocator {
    return this.ownerLocator.last().contentFrame();
  }

  nth(index: number): FrameLocator {
    return this.ownerLocator.nth(index).contentFrame();
  }

  frameLocator(selector: string): FrameLocator {
    return this.contentLocator.frameLocator(selector);
  }

  locator(selector: string): Locator {
    return this.contentLocator.locator(selector);
  }

  getByText(text: string | RegExp, options?: GetByTextOptions): Locator {
    return this.contentLocator.getByText(text, options);
  }

  getByAltText(text: string | RegExp, options?: GetByAltTextOptions): Locator {
    return this.contentLocator.getByAltText(text, options);
  }

  getByLabel(text: string | RegExp, options?: GetByLabelOptions): Locator {
    return this.contentLocator.getByLabel(text, options);
  }

  getByPlaceholder(text: string | RegExp, options?: GetByPlaceholderOptions): Locator {
    return this.contentLocator.getByPlaceholder(text, options);
  }

  getByTestId(testId: string | RegExp): Locator {
    return this.contentLocator.getByTestId(testId);
  }

  getByRole(role: string, options?: GetByRoleOptions): Locator {
    return this.contentLocator.getByRole(role, options);
  }

  getByTitle(text: string | RegExp, options?: GetByTitleOptions): Locator {
    return this.contentLocator.getByTitle(text, options);
  }

  owner(): Locator {
    return this.ownerLocator;
  }
}
