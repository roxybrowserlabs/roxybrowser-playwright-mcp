import type { ElementArrayCallback, ElementCallback } from "./types/api.js";

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
