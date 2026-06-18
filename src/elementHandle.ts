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
  FillOptions,
  HoverOptions,
  PressOptions,
  Rect,
  SelectOptionValue,
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
    values: string | SelectOptionValue | Array<string | SelectOptionValue>
  ): Promise<string[]> {
    return this.adapter.selectOption(values);
  }
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
