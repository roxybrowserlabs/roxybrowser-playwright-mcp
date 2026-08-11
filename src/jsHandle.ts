import {
  assertMaxArguments,
  isSerializedEvaluateCallbacksArg,
  prepareEvaluateWithCallbacksArg,
  serializePageFunction,
  type EvaluateCallbackRegistrar,
  type EvaluateOptions
} from "./evaluation.js";
import { PARSE_EVALUATION_RESULT_SOURCE } from "./protocol/evaluationSerializer.js";
import { serializeEvaluationArgument } from "./elementHandle.js";
import { RoxyElementHandle } from "./elementHandle.js";
import type {
  ProtocolElementHandleReference,
  ProtocolJSHandleAdapter
} from "./protocol/adapter.js";
import { looksLikeFunctionExpression } from "./protocol/evaluate.js";
import type { SerializedValue } from "./utilityScriptSerializers.js";
import type { ElementHandle, JSHandle, PageFunctionOn, SmartHandle, Unboxed } from "./types/api.js";

function cloneJsonValue<T>(value: T): T {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value !== "object") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => cloneJsonValue(entry)) as T;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, cloneJsonValue(entry)])
  ) as T;
}

export class RoxyJSHandle<T = unknown> implements JSHandle<T> {
  constructor(
    private value: T,
    private readonly asElementHandle: ElementHandle | null = null,
    private readonly preview?: string,
    private readonly remoteAdapter?: ProtocolJSHandleAdapter<T>,
    private readonly createElementHandle?: (reference: ProtocolElementHandleReference) => ElementHandle,
    private readonly evaluateCallbackOwner?: EvaluateCallbackRegistrar
  ) {}

  async evaluate<R, Arg, O extends T = T>(
    pageFunction: PageFunctionOn<O, Arg, R>,
    arg: Arg,
    options?: EvaluateOptions
  ): Promise<R>;
  async evaluate<R, O extends T = T>(
    pageFunction: PageFunctionOn<O, void, R>,
    arg?: any,
    options?: EvaluateOptions
  ): Promise<R>;
  async evaluate<R, Arg, O extends T = T>(
    pageFunction: PageFunctionOn<O, Arg, R>,
    arg?: Arg,
    options?: EvaluateOptions
  ): Promise<R> {
    assertMaxArguments(arguments.length, 3);
    const preparedArg = await prepareEvaluateWithCallbacksArg(this.evaluateCallbackOwner, arg, options);
    if (this.remoteAdapter) {
      const expression = serializePageFunction(pageFunction as string | ((element: unknown, arg: Arg) => R | Promise<R>));
      return this.remoteAdapter.evaluate<R>(
        wrapHandleEvaluateFunctionWithCallbacksIfNeeded(expression, preparedArg),
        preparedArg,
        typeof pageFunction === "function" || isSerializedEvaluateCallbacksArg(preparedArg)
      );
    }
    if (isSerializedEvaluateCallbacksArg(preparedArg)) {
      throw new Error("Passing a function is not supported as an argument here");
    }

    if (typeof pageFunction === "string") {
      return (0, eval)(pageFunction) as R;
    }

    return pageFunction(this.value as O, serializeEvaluationArgument(preparedArg) as Unboxed<Arg>);
  }

  async evaluateHandle<R, Arg, O extends T = T>(
    pageFunction: PageFunctionOn<O, Arg, R>,
    arg: Arg,
    options?: EvaluateOptions
  ): Promise<SmartHandle<R>>;
  async evaluateHandle<R, O extends T = T>(
    pageFunction: PageFunctionOn<O, void, R>,
    arg?: any,
    options?: EvaluateOptions
  ): Promise<SmartHandle<R>>;
  async evaluateHandle<R, Arg, O extends T = T>(
    pageFunction: PageFunctionOn<O, Arg, R>,
    arg?: Arg,
    options?: EvaluateOptions
  ): Promise<SmartHandle<R>> {
    assertMaxArguments(arguments.length, 3);
    const preparedArg = await prepareEvaluateWithCallbacksArg(this.evaluateCallbackOwner, arg, options);
    if (this.remoteAdapter?.evaluateHandle) {
      const expression = serializePageFunction(pageFunction as string | ((element: unknown, arg: Arg) => R | Promise<R>));
      return await createRemoteJSHandle(
        await this.remoteAdapter.evaluateHandle<R>(
          wrapHandleEvaluateFunctionWithCallbacksIfNeeded(expression, preparedArg),
          preparedArg,
          typeof pageFunction === "function" || isSerializedEvaluateCallbacksArg(preparedArg)
        ),
        this.createElementHandle,
        this.evaluateCallbackOwner
      ) as unknown as SmartHandle<R>;
    }
    if (isSerializedEvaluateCallbacksArg(preparedArg)) {
      throw new Error("Passing a function is not supported as an argument here");
    }

    const result =
      typeof pageFunction === "string"
        ? ((0, eval)(serializePageFunction(pageFunction)) as R)
        : await pageFunction(this.value as O, serializeEvaluationArgument(preparedArg) as Unboxed<Arg>);
    return createSmartHandle(result);
  }

  async jsonValue(): Promise<T> {
    if (this.remoteAdapter) {
      return this.remoteAdapter.jsonValue();
    }

    return cloneJsonValue(this.value);
  }

  rawValue(): T {
    if (this.remoteAdapter) {
      return this.remoteAdapter.rawValue() as T;
    }

    return this.value;
  }

  _remoteObjectId(): string | undefined {
    return this.remoteAdapter?.remoteObjectId();
  }

  _remoteFrameId(): string | undefined {
    return this.remoteAdapter?.frameId?.();
  }

  _remoteSessionId(): string | undefined {
    return this.remoteAdapter?.sessionId?.();
  }

  _serializedValue(): SerializedValue | undefined {
    return this.remoteAdapter?.serializedValue();
  }

  async _asElementReference(): Promise<ProtocolElementHandleReference | null> {
    return this.remoteAdapter?.asElementReference?.() ?? null;
  }

  asElement(): T extends Node ? ElementHandle<T> : null {
    return this.asElementHandle as T extends Node ? ElementHandle<T> : null;
  }

  async dispose(): Promise<void> {
    if (this.remoteAdapter) {
      await this.remoteAdapter.dispose();
      return;
    }

    this.value = undefined as T;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.dispose();
  }

  async getProperties(): Promise<Map<string, JSHandle>> {
    if (this.remoteAdapter) {
      const properties = await this.remoteAdapter.getProperties();
      const result = new Map<string, JSHandle>();
      for (const [name, adapter] of properties) {
        result.set(name, await createRemoteJSHandle(adapter, this.createElementHandle, this.evaluateCallbackOwner));
      }
      return result;
    }

    if (!this.value || typeof this.value !== "object") {
      return new Map();
    }

    const entries = new Map<string, JSHandle>();
    for (const key of Object.keys(this.value as Record<string, unknown>)) {
      entries.set(key, new RoxyJSHandle((this.value as Record<string, unknown>)[key]));
    }
    return entries;
  }

  async getProperty(propertyName: string): Promise<JSHandle> {
    if (this.remoteAdapter) {
      return createRemoteJSHandle(
        await this.remoteAdapter.getProperty(propertyName),
        this.createElementHandle,
        this.evaluateCallbackOwner
      );
    }

    if (!this.value || typeof this.value !== "object") {
      return new RoxyJSHandle(undefined);
    }

    return new RoxyJSHandle((this.value as Record<string, unknown>)[propertyName]);
  }

  toString(): string {
    if (this.remoteAdapter) {
      return this.remoteAdapter.preview();
    }
    if (this.asElementHandle) {
      return "JSHandle@node";
    }
    if (this.preview) {
      return this.preview;
    }
    return `JSHandle@${typeof this.value}`;
  }
}

function wrapHandleEvaluateFunctionWithCallbacksIfNeeded(expression: string, arg: unknown): string {
  if (!isSerializedEvaluateCallbacksArg(arg)) {
    return expression;
  }
  const isFunction = looksLikeFunctionExpression(expression);
  return `async (handle, payload) => {
    ${PARSE_EVALUATION_RESULT_SOURCE}
    const arg = __roxyParseEvaluationResultValue(payload.__roxyEvaluateCallbacksArg);
    let result = (0, eval)(${JSON.stringify(isFunction ? `(${expression})` : expression)});
    if (${isFunction ? "true" : "false"})
      result = result(handle, arg);
    return result;
  }`;
}

export function createSmartHandle<T>(value: T): SmartHandle<T> {
  if (value instanceof RoxyJSHandle) {
    return value as unknown as SmartHandle<T>;
  }

  if (value instanceof RoxyElementHandle) {
    return value as SmartHandle<T>;
  }

  return new RoxyJSHandle(value) as unknown as SmartHandle<T>;
}

export function createJSHandle<T>(value: T, preview?: string): JSHandle<T> {
  return new RoxyJSHandle(value, null, preview);
}

export async function createRemoteJSHandle<T>(
  adapter: ProtocolJSHandleAdapter<T>,
  createElementHandle?: (reference: ProtocolElementHandleReference) => ElementHandle,
  evaluateCallbackOwner?: EvaluateCallbackRegistrar
): Promise<JSHandle<T>> {
  const elementReference = await adapter.asElementReference?.();
  const asElementHandle = elementReference && createElementHandle
    ? createElementHandle(elementReference)
    : null;
  return new RoxyJSHandle(undefined as T, asElementHandle, undefined, adapter, createElementHandle, evaluateCallbackOwner);
}
