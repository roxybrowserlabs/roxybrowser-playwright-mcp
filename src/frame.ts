import { createSmartHandle } from "./jsHandle.js";
import type { RoxyPage } from "./page.js";
import { TimeoutError } from "./errors.js";
import type { LocatorSelector } from "./protocol/adapter.js";
import type {
  ElementArrayCallback,
  ElementCallback,
  ElementHandle,
  ElementHandleForTag,
  Frame,
  FrameLocator,
  Locator,
  PageFunction,
  PageFunctionOn,
  Response,
  SmartHandle
} from "./types/api.js";
import type {
  ClickOptions,
  DispatchEventOptions,
  FillOptions,
  HoverOptions,
  LoadState,
  PageGotoOptions,
  PageSetContentOptions,
  PressOptions,
  SelectOptionValue,
  SelectorStrictOptions,
  TapOptions,
  TypeOptions,
  WaitForNavigationOptions,
  WaitForSelectorOptions
} from "./types/options.js";
import { urlMatches } from "./urlMatch.js";

type LocatorOptions = {
  has?: Locator;
  hasNot?: Locator;
  hasNotText?: string | RegExp;
  hasText?: string | RegExp;
};
type PageWaitForFunctionOptions = {
  polling?: number | "raf";
  timeout?: number;
};
type FrameSelectOptionValues =
  | null
  | string
  | ElementHandle
  | ReadonlyArray<string>
  | SelectOptionValue
  | ReadonlyArray<ElementHandle>
  | ReadonlyArray<SelectOptionValue>;

export interface RoxyFrameSnapshot {
  id: string;
  name: string;
  nativeFrameId?: string;
  url: string;
  parentId: string | null;
  ownerElementChain: LocatorSelector[];
  referenceChain: LocatorSelector[];
}

export class RoxyFrame implements Frame {
  private detached = false;

  constructor(
    private readonly roxyPage: RoxyPage,
    private snapshot: RoxyFrameSnapshot
  ) {}

  setSnapshot(snapshot: RoxyFrameSnapshot): void {
    this.snapshot = snapshot;
  }

  snapshotState(): RoxyFrameSnapshot {
    return this.snapshot;
  }

  setDetached(detached: boolean): void {
    this.detached = detached;
  }

  page(): RoxyPage {
    return this.roxyPage;
  }

  isDetached(): boolean {
    return this.detached;
  }

  parentFrame(): Frame | null {
    return this.snapshot.parentId ? this.roxyPage.frameById(this.snapshot.parentId) : null;
  }

  childFrames(): Array<Frame> {
    return this.roxyPage.frames().filter((frame) => frame.parentFrame() === this);
  }

  url(): string {
    return this.snapshot.url;
  }

  name(): string {
    return this.snapshot.name;
  }

  async goto(url: string, options: PageGotoOptions = {}): Promise<Response | null> {
    if (this.detached) {
      throw new Error("Navigating frame was detached!");
    }
    const navigationPromise = this.waitForNavigation(options);
    await this.evaluate((targetUrl) => {
      window.location.href = targetUrl;
    }, url);
    return navigationPromise;
  }

  async setContent(html: string, options?: PageSetContentOptions): Promise<void> {
    await this.evaluate((content) => {
      document.open();
      document.write(content);
      document.close();
    }, html);
    if (options?.waitUntil !== "commit") {
      await this.roxyPage.waitForLoadState(
        options?.waitUntil,
        options?.timeout === undefined ? {} : { timeout: options.timeout }
      );
    }
    await this.roxyPage.refreshFramesForExternalMutation();
  }

  async evaluate<R, Arg>(pageFunction: PageFunction<Arg, R>, arg: Arg): Promise<R>;
  async evaluate<R>(pageFunction: PageFunction<void, R>, arg?: any): Promise<R>;
  async evaluate<R, Arg>(pageFunction: PageFunction<Arg, R>, arg?: Arg): Promise<R> {
    await this.roxyPage.prepareForPendingFileChooser();
    return this.roxyPage.evaluateInFrame(this.snapshot, pageFunction, arg);
  }

  async evaluateHandle<R, Arg>(pageFunction: PageFunction<Arg, R>, arg: Arg): Promise<SmartHandle<R>>;
  async evaluateHandle<R>(pageFunction: PageFunction<void, R>, arg?: any): Promise<SmartHandle<R>>;
  async evaluateHandle<R, Arg>(
    pageFunction: PageFunction<Arg, R>,
    arg?: Arg
  ): Promise<SmartHandle<R>> {
    return this.roxyPage.evaluateHandleInFrame(this.snapshot, pageFunction, arg);
  }

  async waitForFunction<R, Arg>(
    pageFunction: PageFunction<Arg, R>,
    arg: Arg,
    options?: PageWaitForFunctionOptions
  ): Promise<SmartHandle<R>>;
  async waitForFunction<R>(
    pageFunction: PageFunction<void, R>,
    arg?: any,
    options?: PageWaitForFunctionOptions
  ): Promise<SmartHandle<R>>;
  async waitForFunction<R, Arg>(
    pageFunction: PageFunction<Arg, R>,
    arg?: Arg,
    options: PageWaitForFunctionOptions = {}
  ): Promise<SmartHandle<R>> {
    const timeout = options.timeout ?? this.roxyPage.defaultTimeout();
    const polling = options.polling ?? "raf";
    if (polling !== "raf" && typeof polling !== "number") {
      throw new Error(`Unknown polling option: ${String(polling)}`);
    }
    if (typeof polling === "number" && polling <= 0) {
      throw new Error("Cannot poll with non-positive interval");
    }

    const start = Date.now();
    while (timeout === 0 || Date.now() - start <= timeout) {
      const result = await this.roxyPage.evaluateInFrame(this.snapshot, pageFunction, arg);
      if (result) {
        return createSmartHandle(result);
      }
      await new Promise((resolve) => setTimeout(resolve, polling === "raf" ? 16 : polling));
    }

    throw new TimeoutError(`frame.waitForFunction: Timeout ${timeout}ms exceeded.`);
  }

  async waitForURL(
    url: string | RegExp | URLPattern | ((url: URL) => boolean),
    options: WaitForNavigationOptions = {}
  ): Promise<void> {
    const timeout = options.timeout ?? this.roxyPage.defaultNavigationTimeout();
    const start = Date.now();
    while (timeout === 0 || Date.now() - start <= timeout) {
      if (this.detached) {
        throw new Error("Navigating frame was detached!");
      }
      await this.roxyPage.refreshFramesForExternalMutation().catch(() => {});
      if (!urlMatches(this.roxyPage.baseURLForMatching(), this.url(), url)) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        continue;
      }
      if (options.waitUntil !== "commit") {
        await this.roxyPage.waitForLoadState(
          options.waitUntil,
          timeout === 0 ? options : { timeout: Math.max(0, timeout - (Date.now() - start)) }
        );
      }
      return;
    }
    throw new TimeoutError(`frame.waitForURL: Timeout ${timeout}ms exceeded.`);
  }

  async waitForNavigation(options: WaitForNavigationOptions = {}): Promise<Response | null> {
    if (this.detached) {
      throw new Error("Navigating frame was detached!");
    }
    const response = await this.roxyPage.waitForNavigation(options);
    if (this.detached) {
      throw new Error("Navigating frame was detached!");
    }
    return response;
  }

  async waitForLoadState(
    state: LoadState = "load",
    options: { timeout?: number } = {}
  ): Promise<void> {
    if (this.detached) {
      throw new Error("Navigating frame was detached!");
    }
    if (state !== "load" && state !== "domcontentloaded" && state !== "networkidle") {
      throw new Error("state: expected one of (load|domcontentloaded|networkidle|commit)");
    }
    await this.roxyPage.waitForLoadState(state, options);
    await this.roxyPage.refreshFramesForExternalMutation().catch(() => {});
    if (this.detached) {
      throw new Error("Navigating frame was detached!");
    }
  }

  async waitForSelector<K extends keyof HTMLElementTagNameMap>(
    selector: K,
    options?: WaitForSelectorOptions & { state?: "visible" | "attached" }
  ): Promise<ElementHandleForTag<K>>;
  async waitForSelector(
    selector: string,
    options?: WaitForSelectorOptions & { state?: "visible" | "attached" }
  ): Promise<ElementHandle<SVGElement | HTMLElement>>;
  async waitForSelector<K extends keyof HTMLElementTagNameMap>(
    selector: K,
    options: WaitForSelectorOptions
  ): Promise<ElementHandleForTag<K> | null>;
  async waitForSelector(
    selector: string,
    options: WaitForSelectorOptions
  ): Promise<null | ElementHandle<SVGElement | HTMLElement>>;
  async waitForSelector(
    selector: string,
    options: WaitForSelectorOptions = {}
  ): Promise<ElementHandle | null> {
    const timeout = options.timeout ?? this.roxyPage.defaultTimeout();
    const state = options.state ?? options.waitFor ?? "visible";
    const startTime = Date.now();

    while (Date.now() - startTime <= timeout) {
      const handle = await this.$(selector);
      const visible = handle ? await handle.isVisible() : false;

      if (state === "attached" && handle) {
        return handle;
      }
      if (state === "visible" && visible && handle) {
        return handle;
      }
      if (state === "hidden" && !visible) {
        return null;
      }
      if (state === "detached" && !handle) {
        return null;
      }

      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    throw new TimeoutError(`Timeout ${timeout}ms exceeded.`);
  }

  async $<K extends keyof HTMLElementTagNameMap>(selector: K, options?: { strict: boolean }): Promise<ElementHandleForTag<K> | null>;
  async $(selector: string, options?: { strict: boolean }): Promise<ElementHandle<SVGElement | HTMLElement> | null>;
  async $(selector: string): Promise<ElementHandle | null> {
    return this.roxyPage.queryInFrame(this.snapshot, selector);
  }

  async $$<K extends keyof HTMLElementTagNameMap>(selector: K): Promise<ElementHandleForTag<K>[]>;
  async $$(selector: string): Promise<ElementHandle<SVGElement | HTMLElement>[]>;
  async $$(selector: string): Promise<ElementHandle[]> {
    return this.roxyPage.queryAllInFrame(this.snapshot, selector);
  }

  async $eval<K extends keyof HTMLElementTagNameMap, R, Arg>(selector: K, pageFunction: PageFunctionOn<HTMLElementTagNameMap[K], Arg, R>, arg: Arg): Promise<R>;
  async $eval<R, Arg, E extends SVGElement | HTMLElement = SVGElement | HTMLElement>(selector: string, pageFunction: PageFunctionOn<E, Arg, R>, arg: Arg): Promise<R>;
  async $eval<K extends keyof HTMLElementTagNameMap, R>(selector: K, pageFunction: PageFunctionOn<HTMLElementTagNameMap[K], void, R>, arg?: any): Promise<R>;
  async $eval<R, E extends SVGElement | HTMLElement = SVGElement | HTMLElement>(selector: string, pageFunction: PageFunctionOn<E, void, R>, arg?: any): Promise<R>;
  async $eval<TResult, TArg = unknown>(
    selector: string,
    pageFunction: string | ElementCallback<TResult, TArg>,
    arg?: TArg
  ): Promise<TResult> {
    return this.roxyPage.evalOnSelectorInFrame(
      this.snapshot,
      selector,
      pageFunction,
      arg
    );
  }

  async $$eval<K extends keyof HTMLElementTagNameMap, R, Arg>(selector: K, pageFunction: PageFunctionOn<HTMLElementTagNameMap[K][], Arg, R>, arg: Arg): Promise<R>;
  async $$eval<R, Arg, E extends SVGElement | HTMLElement = SVGElement | HTMLElement>(selector: string, pageFunction: PageFunctionOn<E[], Arg, R>, arg: Arg): Promise<R>;
  async $$eval<K extends keyof HTMLElementTagNameMap, R>(selector: K, pageFunction: PageFunctionOn<HTMLElementTagNameMap[K][], void, R>, arg?: any): Promise<R>;
  async $$eval<R, E extends SVGElement | HTMLElement = SVGElement | HTMLElement>(selector: string, pageFunction: PageFunctionOn<E[], void, R>, arg?: any): Promise<R>;
  async $$eval<TResult, TArg = unknown>(
    selector: string,
    pageFunction: string | ElementArrayCallback<TResult, TArg>,
    arg?: TArg
  ): Promise<TResult> {
    return this.roxyPage.evalOnSelectorAllInFrame(
      this.snapshot,
      selector,
      pageFunction,
      arg
    );
  }

  locator(selector: string, options?: LocatorOptions): Locator {
    const locator = this.roxyPage.locatorInFrame(this.snapshot, selector);
    return options ? locator.filter(options) : locator;
  }

  frameLocator(selector: string): FrameLocator {
    return this.locator(selector).contentFrame();
  }

  getByText(text: string | RegExp, options?: Parameters<RoxyPage["getByText"]>[1]): Locator {
    return this.roxyPage.getByTextInFrame(this.snapshot, text, options);
  }

  getByAltText(text: string | RegExp, options?: Parameters<RoxyPage["getByAltText"]>[1]): Locator {
    return this.roxyPage.getByAltTextInFrame(this.snapshot, text, options);
  }

  getByLabel(text: string | RegExp, options?: Parameters<RoxyPage["getByLabel"]>[1]): Locator {
    return this.roxyPage.getByLabelInFrame(this.snapshot, text, options);
  }

  getByPlaceholder(
    text: string | RegExp,
    options?: Parameters<RoxyPage["getByPlaceholder"]>[1]
  ): Locator {
    return this.roxyPage.getByPlaceholderInFrame(this.snapshot, text, options);
  }

  getByTestId(testId: string | RegExp): Locator {
    return this.roxyPage.getByTestIdInFrame(this.snapshot, testId);
  }

  getByRole(role: string, options?: Parameters<RoxyPage["getByRole"]>[1]): Locator {
    return this.roxyPage.getByRoleInFrame(this.snapshot, role, options);
  }

  getByTitle(text: string | RegExp, options?: Parameters<RoxyPage["getByTitle"]>[1]): Locator {
    return this.roxyPage.getByTitleInFrame(this.snapshot, text, options);
  }

  async content(): Promise<string> {
    return this.evaluate(() => {
      const doctype = document.doctype
        ? new XMLSerializer().serializeToString(document.doctype)
        : "";
      return doctype + document.documentElement.outerHTML;
    });
  }

  async textContent(selector: string, options?: SelectorStrictOptions): Promise<string | null> {
    return (await this.requiredElementHandleForSelector(selector, "frame.textContent", options)).textContent();
  }

  async innerText(selector: string, options?: SelectorStrictOptions): Promise<string> {
    return (await this.requiredElementHandleForSelector(selector, "frame.innerText", options)).innerText();
  }

  async innerHTML(selector: string, options?: SelectorStrictOptions): Promise<string> {
    return (await this.requiredElementHandleForSelector(selector, "frame.innerHTML", options)).innerHTML();
  }

  async getAttribute(selector: string, name: string, options?: SelectorStrictOptions): Promise<string | null> {
    return (await this.requiredElementHandleForSelector(selector, "frame.getAttribute", options)).getAttribute(name);
  }

  async inputValue(selector: string, options?: SelectorStrictOptions): Promise<string> {
    return (await this.requiredElementHandleForSelector(selector, "frame.inputValue", options)).inputValue();
  }

  async isChecked(selector: string, options?: SelectorStrictOptions): Promise<boolean> {
    return (await this.requiredElementHandleForSelector(selector, "frame.isChecked", options)).isChecked();
  }

  async isDisabled(selector: string, options?: SelectorStrictOptions): Promise<boolean> {
    return (await this.requiredElementHandleForSelector(selector, "frame.isDisabled", options)).isDisabled();
  }

  async isEditable(selector: string, options?: SelectorStrictOptions): Promise<boolean> {
    return (await this.requiredElementHandleForSelector(selector, "frame.isEditable", options)).isEditable();
  }

  async isEnabled(selector: string, options?: SelectorStrictOptions): Promise<boolean> {
    return (await this.requiredElementHandleForSelector(selector, "frame.isEnabled", options)).isEnabled();
  }

  async isHidden(selector: string, options?: SelectorStrictOptions): Promise<boolean> {
    const handle = await this.elementHandleForSelector(selector, options);
    return handle ? handle.isHidden() : true;
  }

  async isVisible(selector: string, options?: SelectorStrictOptions): Promise<boolean> {
    const handle = await this.elementHandleForSelector(selector, options);
    return handle ? handle.isVisible() : false;
  }

  async focus(selector: string, options?: SelectorStrictOptions): Promise<void> {
    await (await this.requiredElementHandleForSelector(selector, "frame.focus", options)).focus();
  }

  async dispatchEvent(selector: string, type: string, eventInit?: unknown, options?: DispatchEventOptions): Promise<void> {
    await this.locator(selector).dispatchEvent(type, eventInit, options);
  }

  async click(selector: string, options?: ClickOptions): Promise<void> {
    await this.roxyPage.prepareForPendingFileChooser();
    await this.locator(selector).click(options);
  }

  async dblclick(selector: string, options?: ClickOptions): Promise<void> {
    await this.locator(selector).dblclick(options);
  }

  async hover(selector: string, options?: HoverOptions): Promise<void> {
    await this.locator(selector).hover(options);
  }

  async tap(selector: string, options?: TapOptions): Promise<void> {
    await this.locator(selector).tap(options);
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

  async check(selector: string, options?: ClickOptions): Promise<void> {
    await this.locator(selector).check(options);
  }

  async uncheck(selector: string, options?: ClickOptions): Promise<void> {
    await this.locator(selector).uncheck(options);
  }

  async setChecked(selector: string, checked: boolean, options?: ClickOptions): Promise<void> {
    await this.locator(selector).setChecked(checked, options);
  }

  async selectOption(
    selector: string,
    values: FrameSelectOptionValues,
    options?: { force?: boolean; noWaitAfter?: boolean; strict?: boolean; timeout?: number }
  ): Promise<Array<string>> {
    return this.locator(selector).selectOption(values, options);
  }

  private async elementHandleForSelector(
    selector: string,
    options?: { strict?: boolean }
  ): Promise<ElementHandle | null> {
    const strict = typeof options?.strict === "boolean"
      ? options.strict
      : false;
    if (strict) {
      const handles = await this.$$(selector);
      if (handles.length > 1) {
        throw new Error(`strict mode violation: selector "${selector}" resolved to ${handles.length} elements`);
      }
      return handles[0] ?? null;
    }
    return this.$(selector);
  }

  private async requiredElementHandleForSelector(
    selector: string,
    apiName: string,
    options?: { strict?: boolean }
  ): Promise<ElementHandle> {
    const handle = await this.elementHandleForSelector(selector, options);
    if (!handle) {
      throw new Error(`${apiName}: Failed to find element matching selector "${selector}"`);
    }
    return handle;
  }
}
