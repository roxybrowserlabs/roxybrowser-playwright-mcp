import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { TimeoutError } from "./errors.js";
import { assertFillValue } from "./assertions.js";
import { abortableDelay, raceWithAbortSignal, throwIfAborted } from "./abortSignal.js";
import {
  assertMaxArguments,
  isSerializedEvaluateCallbacksArg,
  prepareEvaluateWithCallbacksArg,
  serializePageFunction,
  type EvaluateCallbackRegistrar,
  type EvaluateOptions
} from "./evaluation.js";
import { PARSE_EVALUATION_RESULT_SOURCE } from "./protocol/evaluationSerializer.js";
import { setInputFilesOnElement, type InputFiles } from "./inputFiles.js";
import { RoxyJSHandle, createRemoteJSHandle, createSmartHandle } from "./jsHandle.js";
import { normalizeWaitForSelectorOptions, type LegacyWaitForSelectorOptions } from "./waitForSelector.js";
import { normalizeSelectOptionValues } from "./selectOptionValues.js";
import {
  prepareElementDocumentForScreenshot,
  preparePageForScreenshot,
  type ScreenshotPageTarget
} from "./screenshotPreparation.js";
import {
  determineScreenshotType,
  normalizeElementScreenshotClip,
  screenshotOptionsWithFitsViewport,
  validateScreenshotOptions
} from "./screenshotOptions.js";
import { looksLikeFunctionExpression } from "./protocol/evaluate.js";
import type {
  ProtocolElementHandleAdapter,
  ProtocolElementHandleReference
} from "./protocol/adapter.js";
import { parseSelectorChain } from "./selectors.js";
import type { ElementHandle, ElementHandleForTag, Frame, JSHandle, PageFunctionOn, SmartHandle } from "./types/api.js";
import type {
  ClickOptions,
  FillOptions,
  HoverOptions,
  PressOptions,
  Rect,
  ScreenshotOptions,
  SelectTextOptions,
  SelectOptionValue,
  SetInputFilesOptions,
  TapOptions,
  TimeoutOptions,
  TypeOptions,
  WaitForSelectorOptions
} from "./types/options.js";

const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
const ACTION_RETRY_DELAYS_MS = [0, 20, 100, 100, 500];

export interface ElementHandleFrameResolver {
  contentFrameForElement(handle: RoxyElementHandle): Promise<Frame | null>;
  createElementHandleFromReference(reference: ProtocolElementHandleReference): ElementHandle;
  _exposeEvaluateCallback?(name: string, callback: Function): Promise<void>;
  ownerFrameForElement(handle: RoxyElementHandle): Promise<Frame | null>;
  runScreenshotTask?<T>(task: () => Promise<T>): Promise<T>;
}

export class RoxyElementHandle<T extends Node = Node> implements ElementHandle<T> {
  constructor(
    private readonly adapter: ProtocolElementHandleAdapter,
    private readonly frameResolver?: ElementHandleFrameResolver
  ) {}

  reference(): ProtocolElementHandleReference {
    return this.adapter.reference();
  }

  async protocolContentFrameId(): Promise<string | null> {
    return this.adapter.contentFrameId?.() ?? null;
  }

  async protocolOwnerFrameId(): Promise<string | null> {
    return this.adapter.ownerFrameId?.() ?? null;
  }

  async $<K extends keyof HTMLElementTagNameMap>(selector: K, options?: { strict: boolean }): Promise<ElementHandleForTag<K> | null>;
  async $(selector: string, options?: { strict: boolean }): Promise<ElementHandle<SVGElement | HTMLElement> | null>;
  async $(selector: string): Promise<ElementHandle | null> {
    const handle = await this.adapter.query(parseSelectorChain(selector));
    return handle ? new RoxyElementHandle(handle, this.frameResolver) : null;
  }

  async $$<K extends keyof HTMLElementTagNameMap>(selector: K): Promise<ElementHandleForTag<K>[]>;
  async $$(selector: string): Promise<ElementHandle<SVGElement | HTMLElement>[]>;
  async $$(selector: string): Promise<ElementHandle[]> {
    const handles = await this.adapter.queryAll(parseSelectorChain(selector));
    return handles.map((handle) => new RoxyElementHandle(handle, this.frameResolver));
  }

  async $eval<K extends keyof HTMLElementTagNameMap, R, Arg>(selector: K, pageFunction: PageFunctionOn<HTMLElementTagNameMap[K], Arg, R>, arg: Arg): Promise<R>;
  async $eval<R, Arg, E extends SVGElement | HTMLElement = SVGElement | HTMLElement>(selector: string, pageFunction: PageFunctionOn<E, Arg, R>, arg: Arg): Promise<R>;
  async $eval<K extends keyof HTMLElementTagNameMap, R>(selector: K, pageFunction: PageFunctionOn<HTMLElementTagNameMap[K], void, R>, arg?: any): Promise<R>;
  async $eval<R, E extends SVGElement | HTMLElement = SVGElement | HTMLElement>(selector: string, pageFunction: PageFunctionOn<E, void, R>, arg?: any): Promise<R>;
  async $eval<TResult, TArg = unknown>(
    selector: string,
    pageFunction: string | ((element: unknown, arg: TArg) => TResult | Promise<TResult>),
    arg?: TArg
  ): Promise<TResult> {
    assertMaxArguments(arguments.length, 3);
    return this.adapter.evalOnSelector(
      parseSelectorChain(selector),
      serializePageFunction(pageFunction),
      typeof pageFunction === "function",
      serializeEvaluationArgument(arg)
    );
  }

  async $$eval<K extends keyof HTMLElementTagNameMap, R, Arg>(selector: K, pageFunction: PageFunctionOn<HTMLElementTagNameMap[K][], Arg, R>, arg: Arg): Promise<R>;
  async $$eval<R, Arg, E extends SVGElement | HTMLElement = SVGElement | HTMLElement>(selector: string, pageFunction: PageFunctionOn<E[], Arg, R>, arg: Arg): Promise<R>;
  async $$eval<K extends keyof HTMLElementTagNameMap, R>(selector: K, pageFunction: PageFunctionOn<HTMLElementTagNameMap[K][], void, R>, arg?: any): Promise<R>;
  async $$eval<R, E extends SVGElement | HTMLElement = SVGElement | HTMLElement>(selector: string, pageFunction: PageFunctionOn<E[], void, R>, arg?: any): Promise<R>;
  async $$eval<TResult, TArg = unknown>(
    selector: string,
    pageFunction: string | ((elements: unknown[], arg: TArg) => TResult | Promise<TResult>),
    arg?: TArg
  ): Promise<TResult> {
    assertMaxArguments(arguments.length, 3);
    return this.adapter.evalOnSelectorAll(
      parseSelectorChain(selector),
      serializePageFunction(pageFunction),
      typeof pageFunction === "function",
      serializeEvaluationArgument(arg)
    );
  }

  async evaluate<R, Arg, O extends unknown = unknown>(
    pageFunction: PageFunctionOn<O, Arg, R>,
    arg: Arg,
    options?: EvaluateOptions
  ): Promise<R>;
  async evaluate<R, O extends unknown = unknown>(
    pageFunction: PageFunctionOn<O, void, R>,
    arg?: any,
    options?: EvaluateOptions
  ): Promise<R>;
  async evaluate<R, Arg, O extends unknown = unknown>(
    pageFunction: PageFunctionOn<O, Arg, R>,
    arg?: Arg,
    options?: EvaluateOptions
  ): Promise<R> {
    assertMaxArguments(arguments.length, 3);
    const preparedArg = await prepareEvaluateWithCallbacksArg(
      this.frameResolver as EvaluateCallbackRegistrar | undefined,
      arg,
      options
    );
    const expression = serializePageFunction(pageFunction as string | ((element: unknown, arg: Arg) => R | Promise<R>));
    return this.adapter.evaluate(
      wrapElementEvaluateFunctionWithCallbacksIfNeeded(expression, preparedArg),
      preparedArg,
      typeof pageFunction === "function" || isSerializedEvaluateCallbacksArg(preparedArg)
    );
  }

  async evaluateHandle<R, Arg, O extends unknown = unknown>(
    pageFunction: PageFunctionOn<O, Arg, R>,
    arg: Arg,
    options?: EvaluateOptions
  ): Promise<SmartHandle<R>>;
  async evaluateHandle<R, O extends unknown = unknown>(
    pageFunction: PageFunctionOn<O, void, R>,
    arg?: any,
    options?: EvaluateOptions
  ): Promise<SmartHandle<R>>;
  async evaluateHandle<R, Arg, O extends unknown = unknown>(
    pageFunction: PageFunctionOn<O, Arg, R>,
    arg?: Arg,
    options?: EvaluateOptions
  ): Promise<SmartHandle<R>> {
    assertMaxArguments(arguments.length, 3);
    const preparedArg = await prepareEvaluateWithCallbacksArg(
      this.frameResolver as EvaluateCallbackRegistrar | undefined,
      arg,
      options
    );
    const expression = serializePageFunction(pageFunction as string | ((element: unknown, arg: Arg) => R | Promise<R>));
    if (this.adapter.evaluateHandle) {
      return await createRemoteJSHandle(
        await this.adapter.evaluateHandle<R>(
          wrapElementEvaluateFunctionWithCallbacksIfNeeded(expression, preparedArg),
          preparedArg,
          typeof pageFunction === "function" || isSerializedEvaluateCallbacksArg(preparedArg)
        ),
        (reference) => this.frameResolver?.createElementHandleFromReference(reference)
          ?? new RoxyElementHandle(this.adapter, this.frameResolver),
        this.frameResolver as EvaluateCallbackRegistrar | undefined
      ) as unknown as SmartHandle<R>;
    }
    const value = await this.adapter.evaluate<R>(
      wrapElementEvaluateFunctionWithCallbacksIfNeeded(expression, preparedArg),
      preparedArg,
      typeof pageFunction === "function" || isSerializedEvaluateCallbacksArg(preparedArg)
    );
    return createSmartHandle(value);
  }

  async jsonValue(): Promise<T> {
    return this.evaluate((element) => element as T);
  }

  asElement(): T extends Node ? ElementHandle<T> : null {
    return this as unknown as T extends Node ? ElementHandle<T> : null;
  }

  async contentFrame(): Promise<Frame | null> {
    return this.frameResolver?.contentFrameForElement(this) ?? null;
  }

  async ownerFrame(): Promise<Frame | null> {
    return this.frameResolver?.ownerFrameForElement(this) ?? null;
  }

  async dispose(): Promise<void> {}

  async [Symbol.asyncDispose](): Promise<void> {
    await this.dispose();
  }

  async getProperties(): Promise<Map<string, JSHandle>> {
    const value = await this.jsonValue();
    if (!value || typeof value !== "object") {
      return new Map();
    }

    const entries = new Map<string, JSHandle>();
    for (const key of Object.keys(value as Record<string, unknown>)) {
      entries.set(key, new RoxyJSHandle((value as Record<string, unknown>)[key]));
    }
    return entries;
  }

  async getProperty(propertyName: string): Promise<JSHandle> {
    const value = await this.jsonValue();
    if (!value || typeof value !== "object") {
      return new RoxyJSHandle(undefined);
    }

    return new RoxyJSHandle((value as Record<string, unknown>)[propertyName]);
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
    const { state, timeout } = normalizeWaitForSelectorOptions(options, DEFAULT_WAIT_TIMEOUT_MS);
    const startTime = Date.now();
    throwIfAborted(options);

    while (Date.now() - startTime <= timeout) {
      const handle = await this.$(selector);
      throwIfAborted(options);
      const visible = handle ? await handle.isVisible() : false;
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

  async boundingBox(): Promise<Rect | null> {
    return this.adapter.boundingBox();
  }

  async dispatchEvent(type: string, eventInit?: unknown): Promise<void> {
    await this.adapter.dispatchEvent(type, eventInit);
  }

  async screenshot(options?: ScreenshotOptions): Promise<Buffer> {
    throwIfAborted(options);
    const screenshotTask = () => this.screenshotWithoutQueue(options);
    const queue = this.screenshotTaskQueue();
    return raceWithAbortSignal(queue ? queue(screenshotTask) : screenshotTask(), options);
  }

  private async screenshotWithoutQueue(options?: ScreenshotOptions): Promise<Buffer> {
    throwIfAborted(options);
    const screenshotOptions: ScreenshotOptions = { ...options };
    if (!screenshotOptions.type) {
      const inferredType = determineScreenshotType(options ?? {});
      if (inferredType) {
        screenshotOptions.type = inferredType;
      }
    }
    validateScreenshotOptions(screenshotOptions);
    try {
      await this.waitForElementState("visible", options);
    } catch (error) {
      if (error instanceof TimeoutError) {
        throw new TimeoutError(`elementHandle.screenshot: Timeout ${options?.timeout ?? DEFAULT_WAIT_TIMEOUT_MS}ms exceeded\nelement is not visible`);
      }
      throw error;
    }
    await this.scrollIntoViewIfNeeded(options);
    const box = await raceWithAbortSignal(this.boundingBox(), options);
    if (!box) {
      throw new Error("Node is either not visible or not an HTMLElement");
    }
    if (box.width === 0) {
      throw new Error("Node has 0 width.");
    }
    if (box.height === 0) {
      throw new Error("Node has 0 height.");
    }
    const cleanup = await raceWithAbortSignal(this.prepareForScreenshot(screenshotOptions), options);
    const restoreBackground = await raceWithAbortSignal(this.prepareScreenshotBackground(screenshotOptions), options);
    try {
      if ((options as any)?.__testHookBeforeScreenshot) {
        await raceWithAbortSignal((options as any).__testHookBeforeScreenshot(), options);
      }
      const clip = await raceWithAbortSignal(normalizeElementScreenshotClip(box, this, this.screenshotClipOrigin()), options);
      const viewportSize = this.screenshotPageTarget()?.viewportSize();
      const fitsViewport = viewportSize
        ? box.width <= viewportSize.width && box.height <= viewportSize.height
        : true;
      const screenshot = await raceWithAbortSignal(this.adapter.screenshot({
        ...screenshotOptionsWithFitsViewport(screenshotOptions, fitsViewport),
        clip,
        fullPage: false
      }), options);
      if ((options as any)?.__testHookAfterScreenshot) {
        await raceWithAbortSignal((options as any).__testHookAfterScreenshot(), options);
      }
      if (options?.path) {
        await raceWithAbortSignal(mkdir(dirname(options.path), { recursive: true }), options);
        await raceWithAbortSignal(writeFile(options.path, screenshot), options);
      }
      return screenshot;
    } finally {
      await Promise.all([
        cleanup(),
        restoreBackground()
      ]);
    }
  }

  async scrollIntoViewIfNeeded(options?: TimeoutOptions & { signal?: AbortSignal }): Promise<void> {
    throwIfAborted(options);
    await this.waitForScrollIntoViewActionability(options ?? {});
    await raceWithAbortSignal(this.adapter.scrollIntoViewIfNeeded(), options);
  }

  async selectText(options: SelectTextOptions = {}): Promise<void> {
    throwIfAborted(options);
    if (!options.force) {
      await this.waitForSelectTextActionability(options);
    }
    await raceWithAbortSignal(this.adapter.selectText(), options);
  }

  async tap(options?: TapOptions): Promise<void> {
    throwIfAborted(options);
    await raceWithAbortSignal(this.adapter.tap(options), options);
  }

  async waitForElementState(
    state: "disabled" | "editable" | "enabled" | "hidden" | "stable" | "visible",
    options: TimeoutOptions & { signal?: AbortSignal } = {}
  ): Promise<void> {
    throwIfAborted(options);
    const timeout = options.timeout ?? DEFAULT_WAIT_TIMEOUT_MS;
    const startTime = Date.now();
    while (timeout === 0 || Date.now() - startTime <= timeout) {
      const connected = await raceWithAbortSignal(this.isConnectedForElementState(), options);
      if (!connected) {
        if (state === "hidden") {
          return;
        }
        throw new Error("Element is not attached to the DOM");
      }
      if (state === "visible" && await raceWithAbortSignal(this.waitForElementStateCheck(() => this.isVisible(), false), options)) return;
      if (state === "hidden" && await raceWithAbortSignal(this.waitForElementStateCheck(() => this.isHidden(), true), options)) return;
      if (state === "enabled" && await raceWithAbortSignal(this.waitForElementStateCheck(() => this.isEnabled(), false), options)) return;
      if (state === "disabled" && await raceWithAbortSignal(this.waitForElementStateCheck(() => this.isDisabled(), false), options)) return;
      if (state === "editable" && await raceWithAbortSignal(this.waitForElementStateCheck(() => this.isEditable(), false), options)) return;
      if (state === "stable") return;
      await abortableDelay(50, options);
    }
    throw new TimeoutError(`Timeout ${timeout}ms exceeded.`);
  }

  private async isConnectedForElementState(): Promise<boolean> {
    return this.evaluate((node) => (node as Node).isConnected);
  }

  private async waitForElementStateCheck(check: () => Promise<boolean>, detachedResult: boolean): Promise<boolean> {
    try {
      return await check();
    } catch (error) {
      if (error instanceof Error && /not attached|not connected|No element found/i.test(error.message)) {
        if (detachedResult) {
          return true;
        }
        throw new Error("Element is not attached to the DOM");
      }
      throw error;
    }
  }

  private async waitForSelectTextActionability(options: SelectTextOptions): Promise<void> {
    throwIfAborted(options);
    const timeout = options.timeout ?? DEFAULT_WAIT_TIMEOUT_MS;
    const startTime = Date.now();
    let retry = 0;

    while (timeout === 0 || Date.now() - startTime <= timeout) {
      const connected = await raceWithAbortSignal(this.isConnectedForElementState(), options);
      if (!connected) {
        throw new Error("Element is not attached to the DOM");
      }
      if (await raceWithAbortSignal(this.isVisible().catch(() => false), options)) {
        return;
      }

      const delay = ACTION_RETRY_DELAYS_MS[Math.min(retry, ACTION_RETRY_DELAYS_MS.length - 1)] ?? 0;
      retry += 1;
      if (delay > 0) {
        await abortableDelay(delay, options);
      }
    }

    throw new TimeoutError(`Timeout ${timeout}ms exceeded.\nelement is not visible`);
  }

  private async waitForScrollIntoViewActionability(options: TimeoutOptions & { signal?: AbortSignal }): Promise<void> {
    throwIfAborted(options);
    const timeout = options.timeout ?? DEFAULT_WAIT_TIMEOUT_MS;
    const startTime = Date.now();
    let retry = 0;

    while (timeout === 0 || Date.now() - startTime <= timeout) {
      const connected = await raceWithAbortSignal(this.isConnectedForElementState(), options);
      if (!connected) {
        throw new Error("Element is not attached to the DOM");
      }
      if (await raceWithAbortSignal(this.isCssLayoutVisibleForScroll().catch(() => false), options)) {
        return;
      }

      const delay = ACTION_RETRY_DELAYS_MS[Math.min(retry, ACTION_RETRY_DELAYS_MS.length - 1)] ?? 0;
      retry += 1;
      if (delay > 0) {
        await abortableDelay(delay, options);
      }
    }

    throw new TimeoutError(`Timeout ${timeout}ms exceeded.\nelement is not visible\nretrying scroll into view action`);
  }

  private async isCssLayoutVisibleForScroll(): Promise<boolean> {
    return this.evaluate((node) => {
      if (!(node instanceof Element)) {
        return false;
      }
      let current: Element | null = node;
      while (current) {
        const style = current.ownerDocument.defaultView!.getComputedStyle(current);
        if (style.display === "none") {
          return false;
        }
        current = current.parentElement;
      }
      return true;
    });
  }

  async click(options?: ClickOptions): Promise<void> {
    throwIfAborted(options);
    await raceWithAbortSignal(this.adapter.click(options), options);
  }

  async dblclick(options?: ClickOptions): Promise<void> {
    throwIfAborted(options);
    await raceWithAbortSignal(this.adapter.dblclick(options), options);
  }

  async check(options?: ClickOptions): Promise<void> {
    throwIfAborted(options);
    await raceWithAbortSignal(this.adapter.check(options), options);
  }

  async setChecked(checked: boolean, options?: ClickOptions): Promise<void> {
    if (checked) {
      await this.check(options);
      return;
    }
    await this.uncheck(options);
  }

  async hover(options?: HoverOptions): Promise<void> {
    throwIfAborted(options);
    await raceWithAbortSignal(this.adapter.hover(options), options);
  }

  async fill(value: string, options?: FillOptions): Promise<void> {
    assertFillValue(value);
    throwIfAborted(options);
    await raceWithAbortSignal(this.adapter.fill(value, options), options);
  }

  async type(value: string, options?: TypeOptions): Promise<void> {
    throwIfAborted(options);
    await raceWithAbortSignal(this.adapter.type(value, options), options);
  }

  async press(key: string, options?: PressOptions): Promise<void> {
    throwIfAborted(options);
    await raceWithAbortSignal(this.adapter.press(key, options), options);
  }

  async textContent(options?: TimeoutOptions & { signal?: AbortSignal }): Promise<string | null> {
    throwIfAborted(options);
    return raceWithAbortSignal(this.adapter.textContent(), options);
  }

  async innerText(options?: TimeoutOptions & { signal?: AbortSignal }): Promise<string> {
    throwIfAborted(options);
    return raceWithAbortSignal(this.adapter.innerText(), options);
  }

  async innerHTML(options?: TimeoutOptions & { signal?: AbortSignal }): Promise<string> {
    throwIfAborted(options);
    return raceWithAbortSignal(this.adapter.innerHTML(), options);
  }

  async getAttribute(name: string, options?: TimeoutOptions & { signal?: AbortSignal }): Promise<string | null> {
    throwIfAborted(options);
    return raceWithAbortSignal(this.adapter.getAttribute(name), options);
  }

  async inputValue(options?: TimeoutOptions & { signal?: AbortSignal }): Promise<string> {
    throwIfAborted(options);
    return raceWithAbortSignal(this.adapter.inputValue(), options);
  }

  async isChecked(options?: TimeoutOptions & { signal?: AbortSignal }): Promise<boolean> {
    throwIfAborted(options);
    return raceWithAbortSignal(this.adapter.isChecked(), options);
  }

  async isDisabled(options?: TimeoutOptions & { signal?: AbortSignal }): Promise<boolean> {
    throwIfAborted(options);
    return raceWithAbortSignal(this.adapter.isDisabled(), options);
  }

  async isEditable(options?: TimeoutOptions & { signal?: AbortSignal }): Promise<boolean> {
    throwIfAborted(options);
    return raceWithAbortSignal(this.adapter.isEditable(), options);
  }

  async isEnabled(options?: TimeoutOptions & { signal?: AbortSignal }): Promise<boolean> {
    throwIfAborted(options);
    return raceWithAbortSignal(this.adapter.isEnabled(), options);
  }

  async isHidden(): Promise<boolean> {
    return this.adapter.isHidden();
  }

  async isVisible(): Promise<boolean> {
    return this.adapter.isVisible();
  }

  async focus(options?: TimeoutOptions & { signal?: AbortSignal }): Promise<void> {
    throwIfAborted(options);
    await raceWithAbortSignal(this.adapter.focus(), options);
  }

  async uncheck(options?: ClickOptions): Promise<void> {
    throwIfAborted(options);
    await raceWithAbortSignal(this.adapter.uncheck(options), options);
  }

  async selectOption(
    values:
      | null
      | string
      | SelectOptionValue
      | ElementHandle
      | ReadonlyArray<string>
      | ReadonlyArray<SelectOptionValue>
      | ReadonlyArray<ElementHandle>,
    options?: TimeoutOptions & { signal?: AbortSignal }
  ): Promise<Array<string>> {
    throwIfAborted(options);
    const normalized = await raceWithAbortSignal(normalizeSelectOptionValues(this, values), options);
    return raceWithAbortSignal(
      this.adapter.selectOption(normalized, options),
      options
    );
  }

  async setInputFiles(
    files: InputFiles,
    options?: SetInputFilesOptions
  ): Promise<void> {
    await setInputFilesOnElement(this, files, options);
  }

  private async prepareForScreenshot(options: ScreenshotOptions): Promise<() => Promise<void>> {
    const pageTarget = this.screenshotPageTarget();
    if (pageTarget) {
      return preparePageForScreenshot(pageTarget, options);
    }
    return prepareElementDocumentForScreenshot(this, options);
  }

  private screenshotPageTarget(): ScreenshotPageTarget | null {
    const candidate = this.frameResolver as (ElementHandleFrameResolver & Partial<ScreenshotPageTarget>) | undefined;
    return typeof candidate?.frames === "function" ? candidate as ScreenshotPageTarget : null;
  }

  private screenshotTaskQueue(): (<T>(task: () => Promise<T>) => Promise<T>) | null {
    return this.frameResolver?.runScreenshotTask?.bind(this.frameResolver) ?? null;
  }

  private screenshotClipOrigin(): "document" | "viewport" {
    const candidate = this.frameResolver as (
      ElementHandleFrameResolver & { screenshotClipOrigin?: () => "document" | "viewport" }
    ) | undefined;
    return candidate?.screenshotClipOrigin?.() ?? "document";
  }

  private async prepareScreenshotBackground(options: ScreenshotOptions): Promise<() => Promise<void>> {
    const candidate = this.frameResolver as (
      ElementHandleFrameResolver & { prepareScreenshotBackground?: (options: ScreenshotOptions) => Promise<() => Promise<void>> }
    ) | undefined;
    if (candidate?.prepareScreenshotBackground) {
      return candidate.prepareScreenshotBackground(options);
    }
    return async () => {};
  }
}

function wrapElementEvaluateFunctionWithCallbacksIfNeeded(expression: string, arg: unknown): string {
  if (!isSerializedEvaluateCallbacksArg(arg)) {
    return expression;
  }
  const isFunction = looksLikeFunctionExpression(expression);
  return `async (element, payload) => {
    ${PARSE_EVALUATION_RESULT_SOURCE}
    const arg = __roxyParseEvaluationResultValue(payload.__roxyEvaluateCallbacksArg);
    let result = (0, eval)(${JSON.stringify(isFunction ? `(${expression})` : expression)});
    if (${isFunction ? "true" : "false"})
      result = result(element, arg);
    return result;
  }`;
}

export function serializeEvaluationArgument(value: unknown): unknown {
  if (value instanceof RoxyElementHandle) {
    return {
      __roxyElementHandle: value.reference()
    };
  }

  if (value instanceof RoxyJSHandle) {
    return serializeEvaluationArgument(value.rawValue());
  }

  if (Array.isArray(value)) {
    return value.map((entry) => serializeEvaluationArgument(entry));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, serializeEvaluationArgument(entry)])
    );
  }

  return value;
}
