import { mkdir, writeFile } from "node:fs/promises";
import { dirname, extname } from "node:path";
import { TimeoutError } from "./errors.js";
import { assertFillValue } from "./assertions.js";
import { DefaultHumanController } from "./human/controller.js";
import { assertMaxArguments, serializePageFunction } from "./evaluation.js";
import { setInputFilesOnElement, type InputFiles } from "./inputFiles.js";
import { RoxyJSHandle, createRemoteJSHandle, createSmartHandle } from "./jsHandle.js";
import { normalizeWaitForSelectorOptions } from "./waitForSelector.js";
import type { ResolvedHumanizationOptions } from "./human/types.js";
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
  ownerFrameForElement(handle: RoxyElementHandle): Promise<Frame | null>;
}

export class RoxyElementHandle<T extends Node = Node> implements ElementHandle<T> {
  private readonly humanController: DefaultHumanController;

  constructor(
    private readonly adapter: ProtocolElementHandleAdapter,
    private readonly humanDefaults: ResolvedHumanizationOptions,
    private readonly frameResolver?: ElementHandleFrameResolver
  ) {
    this.humanController = new DefaultHumanController(humanDefaults);
  }

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
    return handle ? new RoxyElementHandle(handle, this.humanDefaults, this.frameResolver) : null;
  }

  async $$<K extends keyof HTMLElementTagNameMap>(selector: K): Promise<ElementHandleForTag<K>[]>;
  async $$(selector: string): Promise<ElementHandle<SVGElement | HTMLElement>[]>;
  async $$(selector: string): Promise<ElementHandle[]> {
    const handles = await this.adapter.queryAll(parseSelectorChain(selector));
    return handles.map((handle) => new RoxyElementHandle(handle, this.humanDefaults, this.frameResolver));
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
    arg: Arg
  ): Promise<R>;
  async evaluate<R, O extends unknown = unknown>(
    pageFunction: PageFunctionOn<O, void, R>,
    arg?: any
  ): Promise<R>;
  async evaluate<R, Arg, O extends unknown = unknown>(
    pageFunction: PageFunctionOn<O, Arg, R>,
    arg?: Arg
  ): Promise<R> {
    assertMaxArguments(arguments.length, 2);
    return this.adapter.evaluate(
      serializePageFunction(pageFunction as string | ((element: unknown, arg: Arg) => R | Promise<R>)),
      serializeEvaluationArgument(arg)
    );
  }

  async evaluateHandle<R, Arg, O extends unknown = unknown>(
    pageFunction: PageFunctionOn<O, Arg, R>,
    arg: Arg
  ): Promise<SmartHandle<R>>;
  async evaluateHandle<R, O extends unknown = unknown>(
    pageFunction: PageFunctionOn<O, void, R>,
    arg?: any
  ): Promise<SmartHandle<R>>;
  async evaluateHandle<R, Arg, O extends unknown = unknown>(
    pageFunction: PageFunctionOn<O, Arg, R>,
    arg?: Arg
  ): Promise<SmartHandle<R>> {
    assertMaxArguments(arguments.length, 2);
    if (this.adapter.evaluateHandle) {
      return await createRemoteJSHandle(
        await this.adapter.evaluateHandle<R>(
          serializePageFunction(pageFunction as string | ((element: unknown, arg: Arg) => R | Promise<R>)),
          serializeEvaluationArgument(arg),
          typeof pageFunction === "function"
        ),
        (reference) => this.frameResolver?.createElementHandleFromReference(reference)
          ?? new RoxyElementHandle(this.adapter, this.humanDefaults, this.frameResolver)
      ) as unknown as SmartHandle<R>;
    }
    const value = await this.adapter.evaluate<R>(
      serializePageFunction(pageFunction as string | ((element: unknown, arg: Arg) => R | Promise<R>)),
      serializeEvaluationArgument(arg)
    );
    return createSmartHandle(value);
  }

  async jsonValue(): Promise<T> {
    return this.evaluate((element) => element as T);
  }

  asElement(): ElementHandle | null {
    return this;
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
    options: WaitForSelectorOptions = {}
  ): Promise<ElementHandle | null> {
    const { state, timeout } = normalizeWaitForSelectorOptions(options, DEFAULT_WAIT_TIMEOUT_MS);
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

  async boundingBox(): Promise<Rect | null> {
    return this.adapter.boundingBox();
  }

  async dispatchEvent(type: string, eventInit?: unknown): Promise<void> {
    await this.adapter.dispatchEvent(type, eventInit);
  }

  async screenshot(options?: ScreenshotOptions): Promise<Buffer> {
    await this.waitForElementState("visible", options);
    await this.scrollIntoViewIfNeeded(options);
    const box = await this.boundingBox();
    if (!box) {
      throw new Error("Node is either not visible or not an HTMLElement");
    }
    if (box.width === 0) {
      throw new Error("Node has 0 width.");
    }
    if (box.height === 0) {
      throw new Error("Node has 0 height.");
    }
    const screenshot = await this.adapter.screenshot({
      ...options,
      clip: box,
      fullPage: false,
      type: options?.type ?? inferScreenshotType(options?.path)
    });
    if (options?.path) {
      await mkdir(dirname(options.path), { recursive: true });
      await writeFile(options.path, screenshot);
    }
    return screenshot;
  }

  async scrollIntoViewIfNeeded(options?: TimeoutOptions): Promise<void> {
    await this.waitForScrollIntoViewActionability(options ?? {});
    await this.adapter.scrollIntoViewIfNeeded();
  }

  async selectText(options: SelectTextOptions = {}): Promise<void> {
    if (!options.force) {
      await this.waitForSelectTextActionability(options);
    }
    await this.adapter.selectText();
  }

  async tap(options?: TapOptions): Promise<void> {
    await this.adapter.tap(options);
  }

  async waitForElementState(
    state: "disabled" | "editable" | "enabled" | "hidden" | "stable" | "visible",
    options: TimeoutOptions = {}
  ): Promise<void> {
    const timeout = options.timeout ?? DEFAULT_WAIT_TIMEOUT_MS;
    const startTime = Date.now();
    while (timeout === 0 || Date.now() - startTime <= timeout) {
      const connected = await this.isConnectedForElementState();
      if (!connected) {
        if (state === "hidden") {
          return;
        }
        throw new Error("Element is not attached to the DOM");
      }
      if (state === "visible" && await this.waitForElementStateCheck(() => this.isVisible(), false)) return;
      if (state === "hidden" && await this.waitForElementStateCheck(() => this.isHidden(), true)) return;
      if (state === "enabled" && await this.waitForElementStateCheck(() => this.isEnabled(), false)) return;
      if (state === "disabled" && await this.waitForElementStateCheck(() => this.isDisabled(), false)) return;
      if (state === "editable" && await this.waitForElementStateCheck(() => this.isEditable(), false)) return;
      if (state === "stable") return;
      await new Promise((resolve) => setTimeout(resolve, 50));
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
    const timeout = options.timeout ?? DEFAULT_WAIT_TIMEOUT_MS;
    const startTime = Date.now();
    let retry = 0;

    while (timeout === 0 || Date.now() - startTime <= timeout) {
      const connected = await this.isConnectedForElementState();
      if (!connected) {
        throw new Error("Element is not attached to the DOM");
      }
      if (await this.isVisible().catch(() => false)) {
        return;
      }

      const delay = ACTION_RETRY_DELAYS_MS[Math.min(retry, ACTION_RETRY_DELAYS_MS.length - 1)] ?? 0;
      retry += 1;
      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    throw new TimeoutError(`Timeout ${timeout}ms exceeded.\nelement is not visible`);
  }

  private async waitForScrollIntoViewActionability(options: TimeoutOptions): Promise<void> {
    const timeout = options.timeout ?? DEFAULT_WAIT_TIMEOUT_MS;
    const startTime = Date.now();
    let retry = 0;

    while (timeout === 0 || Date.now() - startTime <= timeout) {
      const connected = await this.isConnectedForElementState();
      if (!connected) {
        throw new Error("Element is not attached to the DOM");
      }
      if (await this.isCssLayoutVisibleForScroll().catch(() => false)) {
        return;
      }

      const delay = ACTION_RETRY_DELAYS_MS[Math.min(retry, ACTION_RETRY_DELAYS_MS.length - 1)] ?? 0;
      retry += 1;
      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
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
    await this.humanController.click(this.adapter, options);
  }

  async dblclick(options?: ClickOptions): Promise<void> {
    await this.adapter.dblclick(options);
  }

  async check(options?: ClickOptions): Promise<void> {
    await this.adapter.check(options);
  }

  async setChecked(checked: boolean, options?: ClickOptions): Promise<void> {
    if (checked) {
      await this.check(options);
      return;
    }
    await this.uncheck(options);
  }

  async hover(options?: HoverOptions): Promise<void> {
    await this.humanController.hover(this.adapter, options);
  }

  async fill(value: string, options?: FillOptions): Promise<void> {
    assertFillValue(value);
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

  async innerText(): Promise<string> {
    return this.adapter.innerText();
  }

  async innerHTML(): Promise<string> {
    return this.adapter.innerHTML();
  }

  async getAttribute(name: string): Promise<string | null> {
    return this.adapter.getAttribute(name);
  }

  async inputValue(_options?: TimeoutOptions): Promise<string> {
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

  async isVisible(): Promise<boolean> {
    return this.adapter.isVisible();
  }

  async focus(): Promise<void> {
    await this.adapter.focus();
  }

  async uncheck(options?: ClickOptions): Promise<void> {
    await this.adapter.uncheck(options);
  }

  async selectOption(
    values:
      | null
      | string
      | SelectOptionValue
      | ElementHandle
      | Array<string | SelectOptionValue | ElementHandle>
  ): Promise<string[]> {
    return this.adapter.selectOption(await normalizeSelectOptionValues(this, values));
  }

  async setInputFiles(
    files: InputFiles,
    _options?: SetInputFilesOptions
  ): Promise<void> {
    await setInputFilesOnElement(this, files);
  }
}

function inferScreenshotType(path?: string): "jpeg" | "png" {
  if (!path) {
    return "png";
  }

  const extension = extname(path).toLowerCase();
  if (extension === ".jpg" || extension === ".jpeg") {
    return "jpeg";
  }

  return "png";
}

export async function normalizeSelectOptionValues(
  select: ElementHandle,
  values:
    | null
    | string
    | SelectOptionValue
    | ElementHandle
    | Array<string | SelectOptionValue | ElementHandle>
): Promise<string | SelectOptionValue | Array<string | SelectOptionValue>> {
  if (values === null) {
    return [];
  }
  const entries = Array.isArray(values) ? values : [values];
  const normalized: Array<string | SelectOptionValue> = [];
  for (const entry of entries) {
    if (entry instanceof RoxyElementHandle) {
      const index = await select.evaluate((selectElement, optionElement) => {
        if (!(selectElement instanceof HTMLSelectElement)) {
          throw new Error("Element is not a <select> element.");
        }
        if (!(optionElement instanceof HTMLOptionElement)) {
          throw new Error("Element is not an <option> element.");
        }
        return Array.from(selectElement.options).indexOf(optionElement);
      }, entry);
      if (index === -1) {
        throw new Error("Option element is not in the <select> element.");
      }
      normalized.push({ index });
      continue;
    }
    normalized.push(entry as string | SelectOptionValue);
  }
  return Array.isArray(values) ? normalized : normalized[0]!;
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
