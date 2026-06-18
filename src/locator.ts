import { TimeoutError } from "./errors.js";
import { assertFillValue } from "./assertions.js";
import type { HumanController } from "./human/types.js";
import { resolveHumanizationOptions } from "./human/profile.js";
import type { ResolvedHumanizationOptions } from "./human/types.js";
import { assertMaxArguments, serializePageFunction } from "./evaluation.js";
import { RoxyElementHandle, serializeEvaluationArgument, type ElementHandleFrameResolver } from "./elementHandle.js";
import type { InputFiles } from "./inputFiles.js";
import { createRemoteJSHandle, createSmartHandle } from "./jsHandle.js";
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
import type {
  Disposable,
  ElementHandle,
  FrameLocator,
  Locator,
  Page,
  PageFunctionOn,
  SmartHandle
} from "./types/api.js";
import type {
  AriaSnapshotOptions,
  ClickOptions,
  DispatchEventOptions,
  DragAndDropOptions,
  FillOptions,
  GetByAltTextOptions,
  GetByLabelOptions,
  GetByPlaceholderOptions,
  GetByRoleOptions,
  GetByTextOptions,
  GetByTitleOptions,
  HoverOptions,
  PressOptions,
  Rect,
  ScreenshotOptions,
  SelectTextOptions,
  SelectOptionValue,
  SetInputFilesOptions,
  TapOptions,
  TimeoutOptions,
  TypeOptions
} from "./types/options.js";

const ENTER_FRAME_SELECTOR: LocatorSelector = {
  strategy: "control",
  value: "enter-frame"
};
const DEFAULT_LOCATOR_HUMAN_DEFAULTS = resolveHumanizationOptions({ enabled: false });
const DEFAULT_WAIT_TIMEOUT_MS = 30_000;

type ActionOptionsLike = { force?: boolean } | undefined;
type LocatorOptions = {
  has?: Locator;
  hasNot?: Locator;
  hasNotText?: string | RegExp;
  hasText?: string | RegExp;
};
type LocatorFilterOptions = LocatorOptions & {
  visible?: boolean;
};
class DisposableStub implements Disposable {
  constructor(private readonly callback: () => Promise<void> | void) {}

  dispose(): Promise<void> | void {
    return this.callback();
  }
}

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
    private readonly frameResolver?: ElementHandleFrameResolver,
    private readonly ownerPage?: Page
  ) {
    this.selectorChain = selectorChain ? selectorChain.map((part) => ({ ...part })) : null;
  }

  _roxySelectorChain(): LocatorSelector[] | null {
    return this.selectorChain ? this.selectorChain.map((part) => ({ ...part })) : null;
  }

  page(): Page {
    if (!this.ownerPage) {
      throw new Error("Locator is not associated with a page.");
    }
    return this.ownerPage;
  }

  private cloneWith(
    adapter: ProtocolLocatorAdapter,
    selectorChain: LocatorSelector[] | null = this.selectorChain
  ): RoxyLocator {
    return new RoxyLocator(
      adapter,
      this.humanController,
      selectorChain,
      this.beforeAction,
      this.humanDefaults,
      this.frameResolver,
      this.ownerPage
    );
  }

  locator(selectorOrLocator: string | Locator, options?: LocatorOptions): Locator {
    if (typeof selectorOrLocator !== "string") {
      return selectorOrLocator.filter(options);
    }
    const selector = selectorOrLocator;
    const chain = parseSelectorChain(selector);
    const locator = new RoxyLocator(
      chainLocator(this.adapter, selector),
      this.humanController,
      [...(this.selectorChain ?? []), ...chain],
      this.beforeAction,
      this.humanDefaults,
      this.frameResolver,
      this.ownerPage
    );
    return options ? locator.filter(options) : locator;
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
        this.frameResolver,
        this.ownerPage
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
      this.frameResolver,
      this.ownerPage
    );
  }

  getByAltText(text: string | RegExp, options?: GetByAltTextOptions): Locator {
    return new RoxyLocator(
      this.adapter.getByAltText(text, options),
      this.humanController,
      this.extendSelectorChain("getByAltText", text, options),
      this.beforeAction,
      this.humanDefaults,
      this.frameResolver,
      this.ownerPage
    );
  }

  getByLabel(text: string | RegExp, options?: GetByLabelOptions): Locator {
    return new RoxyLocator(
      this.adapter.getByLabel(text, options),
      this.humanController,
      this.extendSelectorChain("getByLabel", text, options),
      this.beforeAction,
      this.humanDefaults,
      this.frameResolver,
      this.ownerPage
    );
  }

  getByPlaceholder(text: string | RegExp, options?: GetByPlaceholderOptions): Locator {
    return new RoxyLocator(
      this.adapter.getByPlaceholder(text, options),
      this.humanController,
      this.extendSelectorChain("getByPlaceholder", text, options),
      this.beforeAction,
      this.humanDefaults,
      this.frameResolver,
      this.ownerPage
    );
  }

  getByTestId(testId: string | RegExp): Locator {
    return new RoxyLocator(
      this.adapter.getByTestId(testId),
      this.humanController,
      this.extendSelectorChain("getByTestId", testId),
      this.beforeAction,
      this.humanDefaults,
      this.frameResolver,
      this.ownerPage
    );
  }

  getByRole(role: string, options?: GetByRoleOptions): Locator {
    return new RoxyLocator(
      this.adapter.getByRole(role, options),
      this.humanController,
      this.extendSelectorChain("getByRole", role, options),
      this.beforeAction,
      this.humanDefaults,
      this.frameResolver,
      this.ownerPage
    );
  }

  getByTitle(text: string | RegExp, options?: GetByTitleOptions): Locator {
    return new RoxyLocator(
      this.adapter.getByTitle(text, options),
      this.humanController,
      this.extendSelectorChain("getByTitle", text, options),
      this.beforeAction,
      this.humanDefaults,
      this.frameResolver,
      this.ownerPage
    );
  }

  first(): Locator {
    return this.cloneWith(this.adapter.first());
  }

  last(): Locator {
    return this.cloneWith(this.adapter.last());
  }

  nth(index: number): Locator {
    return this.cloneWith(this.adapter.nth(index));
  }

  filter(options?: LocatorFilterOptions): Locator {
    void options;
    return this.cloneWith(this.adapter);
  }

  and(locator: Locator): Locator {
    void locator;
    return this.cloneWith(this.adapter);
  }

  or(locator: Locator): Locator {
    void locator;
    return this.cloneWith(this.adapter);
  }

  describe(description: string): Locator {
    return this.cloneWith(this.adapter, [
      ...(this.selectorChain ?? []),
      { strategy: "control", value: `describe=${description}` }
    ]);
  }

  description(): string | null {
    const descriptionSelector = [...(this.selectorChain ?? [])].reverse().find(
      (selector: LocatorSelector) => selector.strategy === "control" && selector.value.startsWith("describe=")
    );
    return descriptionSelector ? descriptionSelector.value.slice("describe=".length) : null;
  }

  async all(): Promise<Locator[]> {
    return Array.from({ length: await this.count() }, (_value, index) => this.nth(index));
  }

  async allInnerTexts(): Promise<string[]> {
    return this.evaluateAll((elements) => elements.map((element) => (element as HTMLElement).innerText));
  }

  async allTextContents(): Promise<string[]> {
    return this.evaluateAll((elements) => elements.map((element) => element.textContent || ""));
  }

  async count(): Promise<number> {
    return this.adapter.count();
  }

  async evaluate<R, Arg>(
    pageFunction: PageFunctionOn<SVGElement | HTMLElement, Arg, R>,
    arg: Arg,
    options?: TimeoutOptions
  ): Promise<R>;
  async evaluate<R>(
    pageFunction: PageFunctionOn<SVGElement | HTMLElement, void, R>,
    options?: TimeoutOptions
  ): Promise<R>;
  async evaluate<R, Arg>(
    pageFunction: PageFunctionOn<SVGElement | HTMLElement, Arg, R>,
    argOrOptions?: Arg | TimeoutOptions,
    options?: TimeoutOptions
  ): Promise<R> {
    assertMaxArguments(arguments.length, 3);
    const hasArg = arguments.length >= 2 && (arguments.length !== 2 || !looksLikeTimeoutOptions(argOrOptions));
    void (hasArg ? options : argOrOptions);
    return this.adapter.evaluate<R>(
      serializePageFunction(pageFunction as string | ((element: unknown, arg: Arg) => R | Promise<R>)),
      serializeEvaluationArgument(hasArg ? argOrOptions : undefined),
      typeof pageFunction === "function"
    );
  }

  async evaluateAll<R, Arg>(
    pageFunction: PageFunctionOn<Element[], Arg, R>,
    arg: Arg
  ): Promise<R>;
  async evaluateAll<R>(
    pageFunction: PageFunctionOn<Element[], void, R>
  ): Promise<R>;
  async evaluateAll<R, Arg>(
    pageFunction: PageFunctionOn<Element[], Arg, R>,
    arg?: Arg
  ): Promise<R> {
    assertMaxArguments(arguments.length, 2);
    return this.adapter.evaluateAll<R>(
      serializePageFunction(pageFunction as string | ((elements: unknown[], arg: Arg) => R | Promise<R>)),
      serializeEvaluationArgument(arg),
      typeof pageFunction === "function"
    );
  }

  async evaluateHandle<R, Arg>(
    pageFunction: PageFunctionOn<SVGElement | HTMLElement, Arg, R>,
    arg: Arg,
    options?: TimeoutOptions
  ): Promise<SmartHandle<R>>;
  async evaluateHandle<R>(
    pageFunction: PageFunctionOn<SVGElement | HTMLElement, void, R>,
    options?: TimeoutOptions
  ): Promise<SmartHandle<R>>;
  async evaluateHandle<R, Arg>(
    pageFunction: PageFunctionOn<SVGElement | HTMLElement, Arg, R>,
    argOrOptions?: Arg | TimeoutOptions,
    options?: TimeoutOptions
  ): Promise<SmartHandle<R>> {
    assertMaxArguments(arguments.length, 3);
    const hasArg = arguments.length >= 2 && (arguments.length !== 2 || !looksLikeTimeoutOptions(argOrOptions));
    void (hasArg ? options : argOrOptions);
    if (this.adapter.evaluateHandle) {
      return await createRemoteJSHandle(
        await this.adapter.evaluateHandle<R>(
          serializePageFunction(pageFunction as string | ((element: unknown, arg: Arg) => R | Promise<R>)),
          serializeEvaluationArgument(hasArg ? argOrOptions : undefined),
          typeof pageFunction === "function"
        ),
        (reference) => this.frameResolver?.createElementHandleFromReference(reference)
          ?? new RoxyElementHandle(this.adapter.elementHandle() as never, this.humanDefaults, this.frameResolver)
      ) as unknown as SmartHandle<R>;
    }
    return createSmartHandle(await this.evaluate(pageFunction as PageFunctionOn<SVGElement | HTMLElement, Arg, R>, hasArg ? argOrOptions as Arg : undefined as Arg));
  }

  async boundingBox(options?: TimeoutOptions): Promise<Rect | null> {
    void options;
    return this.adapter.boundingBox();
  }

  async dblclick(options?: ClickOptions): Promise<void> {
    await this.beforeAction?.(this, options);
    await this.adapter.dblclick(options);
  }

  async check(options?: ClickOptions): Promise<void> {
    await this.beforeAction?.(this, options);
    await this.adapter.check(options);
  }

  async clear(options?: FillOptions): Promise<void> {
    await this.fill("", options);
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
    assertFillValue(value);
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

  async pressSequentially(text: string, options?: TypeOptions): Promise<void> {
    await this.type(text, options);
  }

  async focus(): Promise<void> {
    await this.adapter.focus();
  }

  async blur(options?: TimeoutOptions): Promise<void> {
    void options;
    await this.adapter.blur();
  }

  async dispatchEvent(
    type: string,
    eventInit?: unknown,
    options?: DispatchEventOptions
  ): Promise<void> {
    await this.adapter.dispatchEvent(type, eventInit, options);
  }

  async dragTo(target: Locator, options?: DragAndDropOptions): Promise<void> {
    const waitOptions = options?.timeout === undefined ? {} : { timeout: options.timeout };
    const sourceHandle = await this.elementHandle(waitOptions);
    if (!sourceHandle) {
      throw new Error("locator.dragTo: Failed to find source element.");
    }
    const targetHandle = await target.elementHandle(waitOptions);
    if (!targetHandle) {
      throw new Error("locator.dragTo: Failed to find target element.");
    }
    if (options?.trial) {
      return;
    }

    await sourceHandle.evaluate(
      (sourceElement, payload) => {
        const sourceNode = sourceElement as Element | null;
        const targetNode = payload.target as unknown as Element | null;
        if (!sourceNode || !targetNode) {
          throw new Error("Drag source or target is not available.");
        }

        const createEvent = (type: string, dataTransfer: DataTransfer) => {
          return new DragEvent(type, {
            bubbles: true,
            cancelable: true,
            dataTransfer
          });
        };

        const dataTransfer = new DataTransfer();
        sourceNode.dispatchEvent(createEvent("dragstart", dataTransfer));
        targetNode.dispatchEvent(createEvent("dragenter", dataTransfer));
        targetNode.dispatchEvent(createEvent("dragover", dataTransfer));
        targetNode.dispatchEvent(createEvent("drop", dataTransfer));
        sourceNode.dispatchEvent(createEvent("dragend", dataTransfer));
      },
      { target: targetHandle }
    );
  }

  async drop(_payload: unknown, _options?: TimeoutOptions): Promise<void> {
    throw new Error("locator.drop is not implemented yet.");
  }

  async getAttribute(name: string): Promise<string | null> {
    return this.adapter.getAttribute(name);
  }

  async highlight(_options: { style?: string | Record<string, string | number> } = {}): Promise<Disposable> {
    return new DisposableStub(() => this.hideHighlight());
  }

  async hideHighlight(): Promise<void> {}

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

  async ariaSnapshot(options?: AriaSnapshotOptions): Promise<string> {
    void options;
    const handle = await this.elementHandle();
    if (!handle) {
      throw new Error("No element found.");
    }
    return handle.evaluate((element) => element.textContent ?? "");
  }

  async normalize(): Promise<Locator> {
    return this;
  }

  async textContent(): Promise<string | null> {
    return this.adapter.textContent();
  }

  async uncheck(options?: ClickOptions): Promise<void> {
    await this.beforeAction?.(this, options);
    await this.adapter.uncheck(options);
  }

  async selectOption(
    values: string | SelectOptionValue | Array<string | SelectOptionValue> | null,
    options?: TimeoutOptions
  ): Promise<string[]> {
    void options;
    await this.beforeAction?.(this, undefined);
    return this.adapter.selectOption(values === null ? [] : values);
  }

  async screenshot(options?: ScreenshotOptions): Promise<Buffer> {
    return this.adapter.screenshot(options);
  }

  async scrollIntoViewIfNeeded(options?: TimeoutOptions): Promise<void> {
    void options;
    await this.adapter.scrollIntoViewIfNeeded();
  }

  async selectText(options: SelectTextOptions = {}): Promise<void> {
    const handle = await this.elementHandle(options.timeout === undefined ? {} : { timeout: options.timeout });
    if (!handle) {
      throw new Error("No element found.");
    }
    await handle.selectText(options);
  }

  async setChecked(checked: boolean, options?: ClickOptions): Promise<void> {
    if (checked) {
      await this.check(options);
      return;
    }
    await this.uncheck(options);
  }

  async setInputFiles(
    files: InputFiles,
    options?: SetInputFilesOptions
  ): Promise<void> {
    const handle = await this.elementHandle(options?.timeout === undefined ? {} : { timeout: options.timeout });
    if (!handle) {
      throw new Error("No element found.");
    }
    await handle.setInputFiles(files, options);
  }

  async tap(options?: TapOptions): Promise<void> {
    await this.beforeAction?.(this, options);
    await this.adapter.tap(options);
  }

  async isVisible(): Promise<boolean> {
    return this.adapter.isVisible();
  }

  async waitFor(options: { state?: "attached" | "detached" | "hidden" | "visible"; timeout?: number } = {}): Promise<void> {
    const state = options.state ?? "visible";
    const timeout = options.timeout ?? DEFAULT_WAIT_TIMEOUT_MS;
    const startTime = Date.now();

    while (timeout === 0 || Date.now() - startTime <= timeout) {
      const count = await this.count().catch(() => 0);
      const attached = count > 0;
      const visible = attached ? await this.isVisible().catch(() => false) : false;
      if (state === "attached" && attached) return;
      if (state === "visible" && visible) return;
      if (state === "hidden" && !visible) return;
      if (state === "detached" && !attached) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    throw new TimeoutError(`Timeout ${timeout}ms exceeded.`);
  }

  async elementHandle(options: { timeout?: number } = {}): Promise<ElementHandle | null> {
    const timeout = options.timeout ?? DEFAULT_WAIT_TIMEOUT_MS;
    const startTime = Date.now();
    let lastError: unknown;
    while (timeout === 0 || Date.now() - startTime <= timeout) {
      try {
        return new RoxyElementHandle(await this.adapter.elementHandle(), this.humanDefaults, this.frameResolver);
      } catch (error) {
        lastError = error;
        if (timeout === 0) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    if (lastError) {
      throw lastError;
    }
    throw new TimeoutError(`Timeout ${timeout}ms exceeded.`);
  }

  async elementHandles(): Promise<ElementHandle[]> {
    const handles = await this.adapter.elementHandles();
    return handles.map((handle) => new RoxyElementHandle(handle, this.humanDefaults, this.frameResolver));
  }

  toString(): string {
    return `locator('${formatLocatorChain(this.selectorChain ?? [])}')`;
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

  locator(selectorOrLocator: string | Locator, options?: LocatorOptions): Locator {
    return this.contentLocator.locator(selectorOrLocator, options);
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

function looksLikeTimeoutOptions(value: unknown): value is TimeoutOptions {
  return Boolean(
    value
      && typeof value === "object"
      && "timeout" in value
      && Object.keys(value).every((key) => key === "timeout")
  );
}

function formatLocatorChain(chain: LocatorSelector[]): string {
  return chain.map((selector) => {
    if (selector.strategy === "css") return selector.value;
    if (selector.strategy === "control") return `internal:control=${selector.value}`;
    return `${selector.strategy}=${selector.value}`;
  }).join(" >> ");
}
