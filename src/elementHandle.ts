import { TimeoutError } from "./errors.js";
import { DefaultHumanController } from "./human/controller.js";
import { assertMaxArguments, serializePageFunction } from "./evaluation.js";
import { RoxyJSHandle, createRemoteJSHandle, createSmartHandle } from "./jsHandle.js";
import { normalizeWaitForSelectorOptions } from "./waitForSelector.js";
import type { ResolvedHumanizationOptions } from "./human/types.js";
import type {
  ProtocolElementHandleAdapter,
  ProtocolElementHandleReference
} from "./protocol/adapter.js";
import { parseSelectorChain } from "./selectors.js";
import type { ElementHandle, Frame, JSHandle, PageFunctionOn, SmartHandle } from "./types/api.js";
import type {
  ClickOptions,
  FilePayload,
  FillOptions,
  HoverOptions,
  PressOptions,
  Rect,
  ScreenshotOptions,
  SelectOptionValue,
  SetInputFilesOptions,
  TapOptions,
  TimeoutOptions,
  TypeOptions,
  WaitForSelectorOptions
} from "./types/options.js";

const DEFAULT_WAIT_TIMEOUT_MS = 30_000;

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

  async $(selector: string): Promise<ElementHandle | null> {
    const handle = await this.adapter.query(parseSelectorChain(selector));
    return handle ? new RoxyElementHandle(handle, this.humanDefaults, this.frameResolver) : null;
  }

  async $$(selector: string): Promise<ElementHandle[]> {
    const handles = await this.adapter.queryAll(parseSelectorChain(selector));
    return handles.map((handle) => new RoxyElementHandle(handle, this.humanDefaults, this.frameResolver));
  }

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
    return this.adapter.screenshot(options);
  }

  async scrollIntoViewIfNeeded(options?: TimeoutOptions): Promise<void> {
    void options;
    await this.adapter.scrollIntoViewIfNeeded();
  }

  async selectText(options?: TimeoutOptions): Promise<void> {
    void options;
    await this.adapter.selectText();
  }

  async tap(options?: TapOptions): Promise<void> {
    await this.adapter.tap(options);
  }

  async waitForElementState(
    state: "disabled" | "enabled" | "hidden" | "stable" | "visible",
    options: TimeoutOptions = {}
  ): Promise<void> {
    const timeout = options.timeout ?? DEFAULT_WAIT_TIMEOUT_MS;
    const startTime = Date.now();
    while (timeout === 0 || Date.now() - startTime <= timeout) {
      if (state === "visible" && await this.isVisible().catch(() => false)) return;
      if (state === "hidden" && await this.isHidden().catch(() => true)) return;
      if (state === "enabled" && await this.isEnabled().catch(() => false)) return;
      if (state === "disabled" && await this.isDisabled().catch(() => false)) return;
      if (state === "stable") return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new TimeoutError(`Timeout ${timeout}ms exceeded.`);
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
    files: string | ReadonlyArray<string> | FilePayload | ReadonlyArray<FilePayload>,
    _options?: SetInputFilesOptions
  ): Promise<void> {
    const payloads = normalizeFilePayloads(files);
    await this.evaluate(
      (element, entries) => {
        const input = element as HTMLInputElement | null;
        if (!input || input.tagName !== "INPUT" || input.type !== "file") {
          throw new Error("Node is not an HTMLInputElement of type file.");
        }

        const dataTransfer = new DataTransfer();
        for (const entry of entries) {
          const bytes = Uint8Array.from(atob(entry.base64), (char) => char.charCodeAt(0));
          dataTransfer.items.add(
            new File([bytes], entry.name, {
              type: entry.mimeType
            })
          );
        }
        input.files = dataTransfer.files;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      },
      payloads
    );
  }
}

function normalizeFilePayloads(
  files: string | ReadonlyArray<string> | FilePayload | ReadonlyArray<FilePayload>
): Array<{ base64: string; mimeType: string; name: string }> {
  const entries = Array.isArray(files) ? files : [files];
  return entries.map((entry) => {
    if (typeof entry === "string") {
      throw new Error("File paths are not supported by ElementHandle.setInputFiles yet.");
    }
    return {
      base64: entry.buffer.toString("base64"),
      mimeType: entry.mimeType,
      name: entry.name
    };
  });
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
