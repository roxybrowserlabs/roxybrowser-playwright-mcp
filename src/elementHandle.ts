import { TimeoutError } from "./errors.js";
import { DefaultHumanController } from "./human/controller.js";
import { serializePageFunction } from "./evaluation.js";
import { normalizeWaitForSelectorOptions } from "./waitForSelector.js";
import type { ResolvedHumanizationOptions } from "./human/types.js";
import type {
  ProtocolElementHandleAdapter,
  ProtocolElementHandleReference
} from "./protocol/adapter.js";
import { parseSelectorChain } from "./selectors.js";
import type { ElementHandle } from "./types/api.js";
import type {
  ClickOptions,
  FillOptions,
  HoverOptions,
  PressOptions,
  TypeOptions,
  WaitForSelectorOptions
} from "./types/options.js";

const DEFAULT_WAIT_TIMEOUT_MS = 30_000;

export class RoxyElementHandle implements ElementHandle {
  private readonly humanController: DefaultHumanController;

  constructor(
    private readonly adapter: ProtocolElementHandleAdapter,
    private readonly humanDefaults: ResolvedHumanizationOptions
  ) {
    this.humanController = new DefaultHumanController(humanDefaults);
  }

  reference(): ProtocolElementHandleReference {
    return this.adapter.reference();
  }

  async $(selector: string): Promise<ElementHandle | null> {
    const handle = await this.adapter.query(parseSelectorChain(selector));
    return handle ? new RoxyElementHandle(handle, this.humanDefaults) : null;
  }

  async $$(selector: string): Promise<ElementHandle[]> {
    const handles = await this.adapter.queryAll(parseSelectorChain(selector));
    return handles.map((handle) => new RoxyElementHandle(handle, this.humanDefaults));
  }

  async $eval<TResult, TArg = unknown>(
    selector: string,
    pageFunction: string | ((element: unknown, arg: TArg) => TResult | Promise<TResult>),
    arg?: TArg
  ): Promise<TResult> {
    return this.adapter.evalOnSelector(
      parseSelectorChain(selector),
      serializePageFunction(pageFunction),
      serializeEvaluationArgument(arg)
    );
  }

  async $$eval<TResult, TArg = unknown>(
    selector: string,
    pageFunction: string | ((elements: unknown[], arg: TArg) => TResult | Promise<TResult>),
    arg?: TArg
  ): Promise<TResult> {
    return this.adapter.evalOnSelectorAll(
      parseSelectorChain(selector),
      serializePageFunction(pageFunction),
      serializeEvaluationArgument(arg)
    );
  }

  async evaluate<TResult, TArg = unknown>(
    pageFunction: string | ((element: unknown, arg: TArg) => TResult | Promise<TResult>),
    arg?: TArg
  ): Promise<TResult> {
    return this.adapter.evaluate(serializePageFunction(pageFunction), serializeEvaluationArgument(arg));
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

export function serializeEvaluationArgument(value: unknown): unknown {
  if (value instanceof RoxyElementHandle) {
    return {
      __roxyElementHandle: value.reference()
    };
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
