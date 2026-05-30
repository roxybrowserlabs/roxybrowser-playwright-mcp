import type { ElementArrayCallback, ElementCallback } from "./types/api.js";

export function serializePageFunction<TResult, TArg>(
  pageFunction: string | ElementCallback<TResult, TArg> | ElementArrayCallback<TResult, TArg>
): string {
  return typeof pageFunction === "string" ? pageFunction : pageFunction.toString();
}
