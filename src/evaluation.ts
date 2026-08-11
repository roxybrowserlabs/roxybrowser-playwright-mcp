import { randomUUID } from "node:crypto";
import type { ElementArrayCallback, ElementCallback } from "./types/api.js";

export type EvaluateOptions = { exposeFunctions?: boolean };

export interface EvaluateCallbackRegistrar {
  _exposeEvaluateCallback(name: string, callback: Function): Promise<void>;
}

export function serializePageFunction<TResult, TArg>(
  pageFunction: string | ElementCallback<TResult, TArg> | ElementArrayCallback<TResult, TArg>
): string {
  return typeof pageFunction === "string" ? pageFunction : pageFunction.toString();
}

export function assertMaxArguments(count: number, max: number): void {
  if (count > max) {
    throw new Error(
      "Too many arguments. If you need to pass more than 1 argument to the function wrap them in an object."
    );
  }
}

export function assertEvaluateOptions(options: unknown): void {
  if (options !== undefined && (typeof options !== "object" || options === null || Array.isArray(options))) {
    throw new Error(
      "Too many arguments. If you need to pass more than 1 argument to the function wrap them in an object."
    );
  }
}

export async function prepareEvaluateWithCallbacksArg<Arg>(
  page: EvaluateCallbackRegistrar | undefined,
  arg: Arg,
  options: EvaluateOptions | undefined
): Promise<Arg | SerializedEvaluateCallbacksArg> {
  assertEvaluateOptions(options);
  if (!options?.exposeFunctions) {
    return arg;
  }
  if (!page) {
    throw new Error("Passing a function is not supported as an argument here");
  }
  const callbacks: Array<{ name: string; callback: Function }> = [];
  const cloned = serializeEvaluateCallbacksArg(arg, callbacks, { visited: new Map(), lastId: 0 });
  await Promise.all(callbacks.map(({ name, callback }) => page._exposeEvaluateCallback(name, callback)));
  return { __roxyEvaluateCallbacksArg: cloned };
}

export interface SerializedEvaluateCallbacksArg {
  __roxyEvaluateCallbacksArg: unknown;
}

export function isSerializedEvaluateCallbacksArg(value: unknown): value is SerializedEvaluateCallbacksArg {
  return !!value
    && typeof value === "object"
    && "__roxyEvaluateCallbacksArg" in value;
}

function serializeEvaluateCallbacksArg(
  value: unknown,
  callbacks: Array<{ name: string; callback: Function }>,
  visitorInfo: { visited: Map<object, number>; lastId: number }
): unknown {
  if (typeof value === "function") {
    const name = `__roxy_fn_${randomUUID().replaceAll("-", "")}`;
    callbacks.push({ name, callback: value });
    return { fn: name };
  }
  if (typeof value === "symbol" || Object.is(value, undefined)) {
    return { v: "undefined" };
  }
  if (Object.is(value, null)) {
    return { v: "null" };
  }
  if (Object.is(value, NaN)) {
    return { v: "NaN" };
  }
  if (Object.is(value, Infinity)) {
    return { v: "Infinity" };
  }
  if (Object.is(value, -Infinity)) {
    return { v: "-Infinity" };
  }
  if (Object.is(value, -0)) {
    return { v: "-0" };
  }
  if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return value;
  }
  if (typeof value === "bigint") {
    return { bi: value.toString() };
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const existing = visitorInfo.visited.get(value);
  if (existing) {
    return { ref: existing };
  }
  if (value instanceof Date) {
    return { d: value.toJSON() };
  }
  if (value instanceof URL) {
    return { u: value.toJSON() };
  }
  if (value instanceof RegExp) {
    return { r: { p: value.source, f: value.flags } };
  }
  if (Array.isArray(value)) {
    const id = ++visitorInfo.lastId;
    const result: unknown[] = [];
    visitorInfo.visited.set(value, id);
    for (let index = 0; index < value.length; index += 1) {
      result[index] = serializeEvaluateCallbacksArg(value[index], callbacks, visitorInfo);
    }
    return { a: result, id };
  }
  const id = ++visitorInfo.lastId;
  visitorInfo.visited.set(value, id);
  const entries: Array<{ k: string; v: unknown }> = [];
  for (const key of Object.keys(value)) {
    entries.push({
      k: key,
      v: serializeEvaluateCallbacksArg((value as Record<string, unknown>)[key], callbacks, visitorInfo)
    });
  }
  return { o: entries, id };
}
