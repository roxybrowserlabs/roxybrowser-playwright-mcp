import { createSmartHandle } from "./jsHandle.js";
import type { RoxyPage } from "./page.js";
import { assertFillValue } from "./assertions.js";
import { abortableDelay, createAbortError, raceWithAbortSignal, throwIfAborted } from "./abortSignal.js";
import { TimeoutError } from "./errors.js";
import { looksLikeFunctionExpression } from "./protocol/evaluate.js";
import { setInputFilesOnElement, type InputFiles } from "./inputFiles.js";
import type { LocatorSelector, ProtocolElementHandleReference } from "./protocol/adapter.js";
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
  EvaluateOptions,
  EvaluationArgument,
  Response,
  SmartHandle
} from "./types/api.js";
import type {
  ClickOptions,
  DragAndDropOptions,
  DispatchEventOptions,
  FillOptions,
  AddScriptTagOptions,
  AddStyleTagOptions,
  HoverOptions,
  LoadState,
  PageGotoOptions,
  PageSetContentOptions,
  PressOptions,
  SelectOptionValue,
  SelectorStrictOptions,
  SelectorStrictSignalOptions,
  SetInputFilesOptions,
  TapOptions,
  TypeOptions,
  WaitForNavigationOptions,
  WaitForURLOptions,
  WaitForSelectorOptions
} from "./types/options.js";
import { urlMatches } from "./urlMatch.js";
import { normalizeWaitForSelectorOptions, type LegacyWaitForSelectorOptions } from "./waitForSelector.js";

type LocatorOptions = {
  has?: Locator;
  hasNot?: Locator;
  hasNotText?: string | RegExp;
  hasText?: string | RegExp;
};
type PageWaitForFunctionOptions = {
  polling?: number | "raf";
  timeout?: number;
  signal?: AbortSignal;
};
type FrameSelectOptionValues =
  | null
  | string
  | ElementHandle
  | ReadonlyArray<string>
  | { value?: string; label?: string; index?: number; }
  | ReadonlyArray<ElementHandle>
  | ReadonlyArray<{ value?: string; label?: string; index?: number; }>;

export interface RoxyFrameSnapshot {
  id: string;
  name: string;
  nativeFrameId?: string;
  ownerElementReference?: ProtocolElementHandleReference;
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

  _roxyFrameIdentity(): string {
    return this.snapshot.id;
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

  parentFrame(): null | Frame {
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

  async frameElement(): Promise<ElementHandle> {
    if (this.detached) {
      throw new Error("Frame has been detached.");
    }
    await this.roxyPage.refreshFramesForExternalMutation().catch(() => {});
    if (this.detached) {
      throw new Error("Frame has been detached.");
    }
    const handle = await this.roxyPage.frameElementForFrame(this.snapshot);
    if (!handle) {
      throw new Error("Frame has no owner element.");
    }
    return handle;
  }

  async goto(url: string, options: PageGotoOptions = {}): Promise<Response | null> {
    throwIfAborted(options);
    if (this.detached) {
      throw new Error("Navigating frame was detached!");
    }
    return this.roxyPage.gotoInFrame(this.snapshot, url, options);
  }

  async setContent(html: string, options?: PageSetContentOptions): Promise<void> {
    throwIfAborted(options);
    await this.roxyPage.setContentInFrame(this.snapshot, html, options);
  }

  async title(): Promise<string> {
    return this.roxyPage.titleInFrame(this.snapshot);
  }

  async evaluate<R, Arg>(pageFunction: PageFunction<Arg, R>, arg: Arg, options?: EvaluateOptions): Promise<R>;
  async evaluate<R>(pageFunction: PageFunction<void, R>, arg?: any, options?: EvaluateOptions): Promise<R>;
  async evaluate<R, Arg>(
    pageFunction: PageFunction<Arg, R>,
    arg?: Arg,
    options?: EvaluateOptions
  ): Promise<R> {
    await this.roxyPage.refreshFramesForExternalMutation().catch(() => {});
    if (this.detached) {
      throw new Error("frame.evaluate: Frame was detached");
    }
    await this.roxyPage.prepareForPendingFileChooser();
    return this.roxyPage.evaluateInFrame(this.snapshot, pageFunction, arg, options);
  }

  async evaluateHandle<R, Arg>(pageFunction: PageFunction<Arg, R>, arg: Arg, options?: EvaluateOptions): Promise<SmartHandle<R>>;
  async evaluateHandle<R>(pageFunction: PageFunction<void, R>, arg?: any, options?: EvaluateOptions): Promise<SmartHandle<R>>;
  async evaluateHandle<R, Arg>(
    pageFunction: PageFunction<Arg, R>,
    arg?: Arg,
    options?: EvaluateOptions
  ): Promise<SmartHandle<R>> {
    await this.roxyPage.refreshFramesForExternalMutation().catch(() => {});
    if (this.detached) {
      throw new Error("frame.evaluateHandle: Frame was detached");
    }
    return this.roxyPage.evaluateHandleInFrame(this.snapshot, pageFunction, arg, options);
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
    throwIfAborted(options);
    const timeout = options.timeout ?? this.roxyPage.defaultTimeout();
    const polling = options.polling ?? "raf";
    if (polling !== "raf" && typeof polling !== "number") {
      throw new Error(`Unknown polling option: ${String(polling)}`);
    }
    if (typeof polling === "number" && polling <= 0) {
      throw new Error("Cannot poll with non-positive interval");
    }

    const start = Date.now();
    const isFunction = typeof pageFunction === "function" || looksLikeFunctionExpression(String(pageFunction));
    const apiName = this.snapshot.parentId === null ? "page.waitForFunction" : "frame.waitForFunction";
    const detachedError = () => new Error(`${apiName}: Frame was detached`);

    return await new Promise<SmartHandle<R>>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let stop = false;

      const signal = options.signal;
      const cleanup = () => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        signal?.removeEventListener("abort", abortListener);
        this.roxyPage.removeInternalFrameWaitListener("framedetached", frameDetachedListener);
        this.roxyPage.removeInternalFrameWaitListener("close", closeListener);
      };

      const settleResolve = (value: SmartHandle<R>) => {
        if (settled) {
          return;
        }
        settled = true;
        stop = true;
        cleanup();
        resolve(value);
      };

      const settleReject = (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        stop = true;
        cleanup();
        reject(error);
      };

      const closeListener = (() => {
        settleReject(new Error(`${apiName}: Page closed`));
      }) as (page: unknown) => void;

      const frameDetachedListener = ((frame: Frame) => {
        if (frame === this) {
          settleReject(detachedError());
        }
      }) as (frame: Frame) => void;

      const scheduleNextTick = () => {
        if (stop) {
          return;
        }
        if (signal?.aborted) {
          settleReject(createAbortError(signal));
          return;
        }
        timer = setTimeout(() => {
          void tick();
        }, polling === "raf" ? 16 : polling);
      };

      const tick = async () => {
        if (stop) {
          return;
        }
        if (signal?.aborted) {
          settleReject(createAbortError(signal));
          return;
        }
        if (this.detached) {
          settleReject(detachedError());
          return;
        }
        if (timeout !== 0 && Date.now() - start > timeout) {
          settleReject(new TimeoutError(`${apiName}: Timeout ${timeout}ms exceeded.`));
          return;
        }
        try {
          const result = await this.roxyPage.evaluateInFrameWithFunctionFlag(this.snapshot, pageFunction, arg, isFunction).catch((error) => {
            if (isWaitForFunctionExecutionContextDestroyedError(error)) {
              throw new Error(`${apiName}: Execution context was destroyed`);
            }
            throw error;
          });
          if (result) {
            settleResolve(createSmartHandle(result));
            return;
          }
          scheduleNextTick();
        } catch (error) {
          const normalized = error instanceof Error ? error : new Error(String(error));
          if (normalized.message === `${apiName}: Execution context was destroyed` && this.detached) {
            settleReject(detachedError());
            return;
          }
          settleReject(normalized);
        }
      };

      this.roxyPage.addInternalFrameWaitListener("framedetached", frameDetachedListener);
      this.roxyPage.addInternalFrameWaitListener("close", closeListener);
      const abortListener = () => {
        if (signal) {
          settleReject(createAbortError(signal));
        }
      };
      if (signal) {
        signal.addEventListener("abort", abortListener, { once: true });
      }
      void tick();
    });
  }

  async waitForTimeout(timeout: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, timeout));
  }

  async waitForURL(
    url: string | RegExp | URLPattern | ((url: URL) => boolean),
    options: WaitForURLOptions = {}
  ): Promise<void> {
    throwIfAborted(options);
    const timeout = options.timeout ?? this.roxyPage.defaultNavigationTimeout();
    const start = Date.now();
    while (timeout === 0 || Date.now() - start <= timeout) {
      throwIfAborted(options);
      if (this.detached) {
        throw new Error("Navigating frame was detached!");
      }
      await this.roxyPage.refreshFramesForExternalMutation().catch(() => {});
      if (!urlMatches(this.roxyPage.baseURLForMatching(), this.url(), url)) {
        await abortableDelay(50, options);
        continue;
      }
      if (options.waitUntil !== "commit") {
        const loadStateOptions =
          timeout === 0
            ? options
            : {
                ...(options.signal ? { signal: options.signal } : {}),
                timeout: Math.max(0, timeout - (Date.now() - start))
              };
        await this.waitForLoadState(
          options.waitUntil,
          loadStateOptions
        );
      }
      throwIfAborted(options);
      return;
    }
    throw new TimeoutError(`frame.waitForURL: Timeout ${timeout}ms exceeded.`);
  }

  async waitForNavigation(options: WaitForNavigationOptions = {}): Promise<Response | null> {
    if (this.detached) {
      throw new Error("Navigating frame was detached!");
    }
    const response = await this.roxyPage.waitForNavigationInFrame(this.snapshot, options);
    if (this.detached) {
      throw new Error("Navigating frame was detached!");
    }
    return response;
  }

  async waitForLoadState(
    state: LoadState = "load",
    options: { signal?: AbortSignal; timeout?: number } = {}
  ): Promise<void> {
    throwIfAborted(options);
    if (this.detached) {
      throw new Error("Navigating frame was detached!");
    }
    if (state !== "load" && state !== "domcontentloaded" && state !== "networkidle") {
      throw new Error("state: expected one of (load|domcontentloaded|networkidle|commit)");
    }
    await this.roxyPage.waitForFrameLoadState(this.snapshot, state, options);
    throwIfAborted(options);
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
    options: LegacyWaitForSelectorOptions = {}
  ): Promise<ElementHandle | null> {
    const { state, timeout } = normalizeWaitForSelectorOptions(options, this.roxyPage.defaultTimeout());
    const startTime = Date.now();
    throwIfAborted(options);

    while (Date.now() - startTime <= timeout) {
      const handle = await raceWithAbortSignal(
        this.$(
          selector,
          { strict: this.strictForSelectorOptions(options) }
        ),
        options
      );
      throwIfAborted(options);
      const visible = handle ? await raceWithAbortSignal(handle.isVisible(), options) : false;
      throwIfAborted(options);

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

      await abortableDelay(50, options);
    }

    throw new TimeoutError(`Timeout ${timeout}ms exceeded.`);
  }

  async $<K extends keyof HTMLElementTagNameMap>(selector: K, options?: { strict: boolean }): Promise<ElementHandleForTag<K> | null>;
  async $(selector: string, options?: { strict: boolean }): Promise<ElementHandle<SVGElement | HTMLElement> | null>;
  async $(selector: string, options?: { strict: boolean }): Promise<ElementHandle | null> {
    return this.roxyPage.queryInFrame(this.snapshot, selector, options);
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
    return this.evalOnSelectorForPage(selector, pageFunction, arg);
  }

  async evalOnSelectorForPage<TResult, TArg = unknown>(
    selector: string,
    pageFunction: string | ElementCallback<TResult, TArg>,
    arg?: TArg
  ): Promise<TResult> {
    await this.roxyPage.prepareForPendingFileChooser();
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
    return this.evalOnSelectorAllForPage(selector, pageFunction, arg);
  }

  async evalOnSelectorAllForPage<TResult, TArg = unknown>(
    selector: string,
    pageFunction: string | ElementArrayCallback<TResult, TArg>,
    arg?: TArg
  ): Promise<TResult> {
    await this.roxyPage.prepareForPendingFileChooser();
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
    return this.roxyPage.contentInFrame(this.snapshot);
  }

  async addScriptTag(options: AddScriptTagOptions = {}): Promise<ElementHandle> {
    return this.roxyPage.addScriptTagInFrame(this.snapshot, options);
  }

  async addStyleTag(options: AddStyleTagOptions = {}): Promise<ElementHandle> {
    return this.roxyPage.addStyleTagInFrame(this.snapshot, options);
  }

  async textContent(selector: string, options?: SelectorStrictSignalOptions): Promise<string | null> {
    const handle = await this.requiredElementHandleForSelector(selector, "frame.textContent", options);
    return raceWithAbortSignal(handle.textContent(), options);
  }

  async innerText(selector: string, options?: SelectorStrictSignalOptions): Promise<string> {
    const handle = await this.requiredElementHandleForSelector(selector, "frame.innerText", options);
    return raceWithAbortSignal(handle.innerText(), options);
  }

  async innerHTML(selector: string, options?: SelectorStrictSignalOptions): Promise<string> {
    const handle = await this.requiredElementHandleForSelector(selector, "frame.innerHTML", options);
    return raceWithAbortSignal(handle.innerHTML(), options);
  }

  async getAttribute(selector: string, name: string, options?: SelectorStrictSignalOptions): Promise<string | null> {
    const handle = await this.requiredElementHandleForSelector(selector, "frame.getAttribute", options);
    return raceWithAbortSignal(handle.getAttribute(name), options);
  }

  async inputValue(selector: string, options?: SelectorStrictSignalOptions): Promise<string> {
    const handle = await this.requiredElementHandleForSelector(selector, "frame.inputValue", options);
    return raceWithAbortSignal(handle.inputValue(), options);
  }

  async isChecked(selector: string, options?: SelectorStrictSignalOptions): Promise<boolean> {
    const handle = await this.requiredElementHandleForSelector(selector, "frame.isChecked", options);
    return raceWithAbortSignal(handle.isChecked(), options);
  }

  async isDisabled(selector: string, options?: SelectorStrictSignalOptions): Promise<boolean> {
    const handle = await this.requiredElementHandleForSelector(selector, "frame.isDisabled", options);
    return raceWithAbortSignal(handle.isDisabled(), options);
  }

  async isEditable(selector: string, options?: SelectorStrictSignalOptions): Promise<boolean> {
    const handle = await this.requiredElementHandleForSelector(selector, "frame.isEditable", options);
    return raceWithAbortSignal(handle.isEditable(), options);
  }

  async isEnabled(selector: string, options?: SelectorStrictSignalOptions): Promise<boolean> {
    const handle = await this.requiredElementHandleForSelector(selector, "frame.isEnabled", options);
    return raceWithAbortSignal(handle.isEnabled(), options);
  }

  async isHidden(selector: string, options?: SelectorStrictOptions): Promise<boolean> {
    const handle = await this.elementHandleForSelector(selector, options);
    return handle ? handle.isHidden() : true;
  }

  async isVisible(selector: string, options?: SelectorStrictOptions): Promise<boolean> {
    const handle = await this.elementHandleForSelector(selector, options);
    return handle ? handle.isVisible() : false;
  }

  async focus(selector: string, options?: SelectorStrictSignalOptions): Promise<void> {
    const handle = await this.requiredElementHandleForSelector(selector, "frame.focus", options);
    await raceWithAbortSignal(handle.focus(), options);
  }

  async dispatchEvent(selector: string, type: string, eventInit?: EvaluationArgument, options?: DispatchEventOptions): Promise<void> {
    throwIfAborted(options);
    await raceWithAbortSignal(this.locator(selector).dispatchEvent(type, eventInit, options), options);
  }

  async dragAndDrop(source: string, target: string, options?: DragAndDropOptions): Promise<void> {
    throwIfAborted(options);
    await this.locator(source).dragTo(this.locator(target), options);
  }

  async click(selector: string, options?: ClickOptions): Promise<void> {
    throwIfAborted(options);
	    await this.roxyPage.prepareForPendingFileChooser();
	    const handle = await this.requiredElementHandleForSelector(selector, "frame.click", options);
	    const mayTriggerLinkNavigation = await handle.evaluate((element) => {
	      if (!(element instanceof Element)) {
	        return false;
	      }
	      const link = element.closest("a[href], area[href]");
	      if (!link) {
	        return false;
	      }
	      const target = (link.getAttribute("target") ?? "").toLowerCase();
	      return !target || target === "_self";
	    }).catch(() => false);
	    if (options?.noWaitAfter) {
	      await raceWithAbortSignal(handle.click(options), options);
	      return;
    }
    let navigated = false;
    let resolveNavigationObserved: (() => void) | null = null;
    const navigationObserved = new Promise<void>((resolve) => {
      resolveNavigationObserved = resolve;
    });
    const navigationListener = ((frame: Frame) => {
      if (frame === this) {
        navigated = true;
        resolveNavigationObserved?.();
      }
    }) as (frame: Frame) => void;
    this.roxyPage.addInternalNavigationWaitListener("framenavigated", navigationListener);
    try {
	      await raceWithAbortSignal(handle.click(options), options);
	      await Promise.race([
	        navigationObserved,
	        abortableDelay(mayTriggerLinkNavigation ? 300 : 50, options)
	      ]);
    } finally {
      this.roxyPage.removeInternalNavigationWaitListener("framenavigated", navigationListener);
    }
    if (!navigated) {
      return;
    }
    await this.waitForLoadState("load", {
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
      ...(options?.timeout === undefined ? {} : { timeout: options.timeout })
    }).catch(() => null);
  }

  async dblclick(selector: string, options?: ClickOptions): Promise<void> {
    throwIfAborted(options);
    await raceWithAbortSignal(
      (await this.requiredElementHandleForSelector(selector, "frame.dblclick", options)).dblclick(options),
      options
    );
  }

  async hover(selector: string, options?: HoverOptions): Promise<void> {
    throwIfAborted(options);
    await raceWithAbortSignal(
      (await this.requiredElementHandleForSelector(selector, "frame.hover", options)).hover(options),
      options
    );
  }

  async tap(selector: string, options?: TapOptions): Promise<void> {
    throwIfAborted(options);
    await raceWithAbortSignal(
      (await this.requiredElementHandleForSelector(selector, "frame.tap", options)).tap(options),
      options
    );
  }

  async fill(selector: string, value: string, options?: FillOptions): Promise<void> {
    assertFillValue(value);
    throwIfAborted(options);
    const apiName = this.snapshot.parentId === null ? "page.fill" : "frame.fill";
    await raceWithAbortSignal(
      (await this.requiredElementHandleForSelector(selector, apiName, options)).fill(value, options),
      options
    );
  }

  async type(selector: string, value: string, options?: TypeOptions): Promise<void> {
    throwIfAborted(options);
    await raceWithAbortSignal(
      (await this.requiredElementHandleForSelector(selector, "frame.type", options)).type(value, options),
      options
    );
  }

  async press(selector: string, key: string, options?: PressOptions): Promise<void> {
    throwIfAborted(options);
    await raceWithAbortSignal(
      (await this.requiredElementHandleForSelector(selector, "frame.press", options)).press(key, options),
      options
    );
  }

  async check(selector: string, options?: ClickOptions): Promise<void> {
    throwIfAborted(options);
    await raceWithAbortSignal(
      (await this.requiredElementHandleForSelector(selector, "frame.check", options)).check(options),
      options
    );
  }

  async uncheck(selector: string, options?: ClickOptions): Promise<void> {
    throwIfAborted(options);
    await raceWithAbortSignal(
      (await this.requiredElementHandleForSelector(selector, "frame.uncheck", options)).uncheck(options),
      options
    );
  }

  async setChecked(selector: string, checked: boolean, options?: ClickOptions): Promise<void> {
    throwIfAborted(options);
    await raceWithAbortSignal(
      (await this.requiredElementHandleForSelector(selector, "frame.setChecked", options)).setChecked(checked, options),
      options
    );
  }

  async selectOption(
    selector: string,
    values: FrameSelectOptionValues,
    options?: { force?: boolean; noWaitAfter?: boolean; signal?: AbortSignal; strict?: boolean; timeout?: number }
  ): Promise<Array<string>> {
    throwIfAborted(options);
    return raceWithAbortSignal(
      (await this.requiredElementHandleForSelector(selector, "frame.selectOption", options)).selectOption(values, options),
      options
    );
  }

  async setInputFiles(
    selector: string,
    files: InputFiles,
    options?: SetInputFilesOptions
  ): Promise<void> {
    throwIfAborted(options);
    await setInputFilesOnElement(
      await raceWithAbortSignal(this.requiredElementHandleForSelector(selector, "frame.setInputFiles", options), options),
      files,
      options
    );
  }

  private async elementHandleForSelector(
    selector: string,
    options?: { strict?: boolean }
  ): Promise<ElementHandle | null> {
    await this.roxyPage.refreshFramesForExternalMutation().catch(() => {});
    if (this.detached) {
      throw new Error("Frame has been detached.");
    }
    return this.roxyPage.queryInFrame(this.snapshot, selector, {
      strict: this.strictForSelectorOptions(options)
    });
  }

  private strictForSelectorOptions(options?: { strict?: boolean }): boolean {
    return typeof options?.strict === "boolean"
      ? options.strict
      : this.roxyPage.strictSelectors();
  }

  private async requiredElementHandleForSelector(
    selector: string,
    apiName: string,
    options?: { signal?: AbortSignal; strict?: boolean }
  ): Promise<ElementHandle> {
    throwIfAborted(options);
    const handle = await raceWithAbortSignal(this.elementHandleForSelector(selector, options), options);
    if (!handle) {
      throw new Error(`${apiName}: Failed to find element matching selector "${selector}"`);
    }
    return handle;
  }
}

function isWaitForFunctionExecutionContextDestroyedError(error: unknown): boolean {
  const message = String(error instanceof Error ? error.message : error);
  return (
    message.includes("Cannot find context with specified id")
    || message.includes("Execution context was destroyed")
    || message.includes("Session with given id not found")
    || message.includes("Frame execution context is not available")
    || message.includes("Frame was detached")
    || message.includes("Frame is not available")
  );
}
