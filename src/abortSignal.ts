import { AbortError } from "./errors.js";

export interface AbortSignalOptions {
  signal?: AbortSignal;
}

export function throwIfAborted(options?: AbortSignalOptions): void {
  const signal = options?.signal;
  if (signal?.aborted) {
    throw createAbortError(signal);
  }
}

export async function abortableDelay(duration: number, options?: AbortSignalOptions): Promise<void> {
  throwIfAborted(options);
  if (duration <= 0) {
    return;
  }
  const signal = options?.signal;
  if (!signal) {
    await new Promise((resolve) => setTimeout(resolve, duration));
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, duration);
    const onAbort = () => {
      cleanup();
      reject(createAbortError(signal));
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function raceWithAbortSignal<T>(promise: Promise<T>, options?: AbortSignalOptions): Promise<T> {
  throwIfAborted(options);
  const signal = options?.signal;
  if (!signal) {
    return promise;
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(createAbortError(signal));
    };
    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      }
    );
  });
}

export function linkAbortSignal(controller: AbortController, signal?: AbortSignal): () => void {
  if (!signal) {
    return () => {};
  }
  if (signal.aborted) {
    controller.abort(createAbortError(signal));
    return () => {};
  }
  const onAbort = () => {
    controller.abort(createAbortError(signal));
  };
  signal.addEventListener("abort", onAbort, { once: true });
  return () => {
    signal.removeEventListener("abort", onAbort);
  };
}

export function createAbortError(signal: AbortSignal): AbortError {
  return new AbortError(undefined, { cause: signal.reason });
}
