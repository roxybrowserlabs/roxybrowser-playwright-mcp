import { createSmartHandle } from "./jsHandle.js";
import { serializePageFunction } from "./evaluation.js";
import { serializeEvaluationArgument } from "./elementHandle.js";
import { TimeoutError } from "./errors.js";
import type { PageFunction, SmartHandle, Worker } from "./types/api.js";

export class RoxyWorker implements Worker {
  private readonly closeListeners = new Set<(worker: Worker) => any>();
  private closed = false;

  constructor(private readonly workerUrl = "about:blank") {}

  async evaluate<R, Arg>(pageFunction: PageFunction<Arg, R>, arg: Arg): Promise<R>;
  async evaluate<R>(pageFunction: PageFunction<void, R>, arg?: any): Promise<R>;
  async evaluate<R, Arg>(pageFunction: PageFunction<Arg, R>, arg?: Arg): Promise<R> {
    if (typeof pageFunction === "string") {
      return (0, eval)(pageFunction) as R;
    }
    return pageFunction(serializeEvaluationArgument(arg) as Arg);
  }

  async evaluateHandle<R, Arg>(
    pageFunction: PageFunction<Arg, R>,
    arg: Arg
  ): Promise<SmartHandle<R>>;
  async evaluateHandle<R>(pageFunction: PageFunction<void, R>, arg?: any): Promise<SmartHandle<R>>;
  async evaluateHandle<R, Arg>(
    pageFunction: PageFunction<Arg, R>,
    arg?: Arg
  ): Promise<SmartHandle<R>> {
    const result =
      typeof pageFunction === "string"
        ? ((0, eval)(serializePageFunction(pageFunction)) as R)
        : await pageFunction(serializeEvaluationArgument(arg) as Arg);
    return createSmartHandle(result);
  }

  on(event: "close", listener: (worker: Worker) => any): this {
    if (event === "close") {
      this.closeListeners.add(listener);
    }
    return this;
  }

  once(event: "close", listener: (worker: Worker) => any): this {
    if (event !== "close") {
      return this;
    }
    const wrapped = (worker: Worker) => {
      this.removeListener("close", wrapped);
      listener(worker);
    };
    return this.on("close", wrapped);
  }

  addListener(event: "close", listener: (worker: Worker) => any): this {
    return this.on(event, listener);
  }

  removeListener(event: "close", listener: (worker: Worker) => any): this {
    if (event === "close") {
      this.closeListeners.delete(listener);
    }
    return this;
  }

  off(event: "close", listener: (worker: Worker) => any): this {
    return this.removeListener(event, listener);
  }

  prependListener(event: "close", listener: (worker: Worker) => any): this {
    if (event !== "close") {
      return this;
    }
    const reordered = new Set<(worker: Worker) => any>([listener, ...this.closeListeners]);
    this.closeListeners.clear();
    for (const entry of reordered) {
      this.closeListeners.add(entry);
    }
    return this;
  }

  url(): string {
    return this.workerUrl;
  }

  async waitForEvent(
    event: "close",
    optionsOrPredicate?:
      | ((worker: Worker) => boolean | Promise<boolean>)
      | {
          predicate?: (worker: Worker) => boolean | Promise<boolean>;
          timeout?: number;
        }
  ): Promise<Worker> {
    const predicate =
      typeof optionsOrPredicate === "function"
        ? optionsOrPredicate
        : optionsOrPredicate?.predicate;
    const timeout =
      typeof optionsOrPredicate === "function"
        ? 30_000
        : optionsOrPredicate?.timeout ?? 30_000;

    if (this.closed) {
      const accepted = predicate ? await predicate(this) : true;
      if (accepted) {
        return this;
      }
    }

    return new Promise<Worker>((resolve, reject) => {
      const listener = async (worker: Worker) => {
        try {
          const accepted = predicate ? await predicate(worker) : true;
          if (!accepted) {
            return;
          }
          clearTimeout(timer);
          this.removeListener("close", listener);
          resolve(worker);
        } catch (error) {
          clearTimeout(timer);
          this.removeListener("close", listener);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      };
      const timer = setTimeout(() => {
        this.removeListener("close", listener);
        reject(new TimeoutError(`Timed out waiting for event "${event}".`));
      }, timeout);
      this.on("close", listener);
    });
  }

  emitClose(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const listener of Array.from(this.closeListeners)) {
      listener(this);
    }
  }
}
