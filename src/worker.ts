import { createSmartHandle } from "./jsHandle.js";
import { serializePageFunction } from "./evaluation.js";
import { serializeEvaluationArgument } from "./elementHandle.js";
import { TimeoutError } from "./errors.js";
import type { PageFunction, SmartHandle, Unboxed, Worker } from "./types/api.js";
import type { PageConsoleMessage } from "./types/events.js";

export interface WorkerDelegate {
  evaluate<R, Arg>(pageFunction: PageFunction<Arg, R>, arg?: Arg): Promise<R>;
  evaluateHandle<R, Arg>(pageFunction: PageFunction<Arg, R>, arg?: Arg): Promise<SmartHandle<R>>;
  url(): string;
}

export class RoxyWorker implements Worker {
  private readonly closeListeners = new Set<(worker: Worker) => any>();
  private readonly consoleListeners = new Set<(consoleMessage: PageConsoleMessage) => any>();
  private closed = false;

  constructor(
    private readonly workerUrl = "about:blank",
    private readonly delegate?: WorkerDelegate
  ) {}

  async evaluate<R, Arg>(pageFunction: PageFunction<Arg, R>, arg: Arg): Promise<R>;
  async evaluate<R>(pageFunction: PageFunction<void, R>, arg?: any): Promise<R>;
  async evaluate<R, Arg>(pageFunction: PageFunction<Arg, R>, arg?: Arg): Promise<R> {
    if (this.delegate) {
      return this.delegate.evaluate(pageFunction, arg);
    }
    if (typeof pageFunction === "string") {
      return (0, eval)(pageFunction) as R;
    }
    return pageFunction(serializeEvaluationArgument(arg) as Unboxed<Arg>);
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
    if (this.delegate) {
      return this.delegate.evaluateHandle(pageFunction, arg);
    }
    const result =
      typeof pageFunction === "string"
        ? ((0, eval)(serializePageFunction(pageFunction)) as R)
        : await pageFunction(serializeEvaluationArgument(arg) as Unboxed<Arg>);
    return createSmartHandle(result);
  }

  on(event: "close", listener: (worker: Worker) => any): this;
  on(event: "console", listener: (consoleMessage: PageConsoleMessage) => any): this;
  on(
    event: "close" | "console",
    listener: ((worker: Worker) => any) | ((consoleMessage: PageConsoleMessage) => any)
  ): this {
    if (event === "close") {
      this.closeListeners.add(listener as (worker: Worker) => any);
    } else {
      this.consoleListeners.add(listener as (consoleMessage: PageConsoleMessage) => any);
    }
    return this;
  }

  once(event: "close", listener: (worker: Worker) => any): this;
  once(event: "console", listener: (consoleMessage: PageConsoleMessage) => any): this;
  once(
    event: "close" | "console",
    listener: ((worker: Worker) => any) | ((consoleMessage: PageConsoleMessage) => any)
  ): this {
    if (event === "close") {
      const wrapped = (worker: Worker) => {
        this.removeListener("close", wrapped);
        (listener as (worker: Worker) => any)(worker);
      };
      return this.on("close", wrapped);
    }
    const wrapped = (message: PageConsoleMessage) => {
      this.removeListener("console", wrapped);
      (listener as (consoleMessage: PageConsoleMessage) => any)(message);
    };
    return this.on("console", wrapped);
  }

  addListener(event: "close", listener: (worker: Worker) => any): this;
  addListener(event: "console", listener: (consoleMessage: PageConsoleMessage) => any): this;
  addListener(
    event: "close" | "console",
    listener: ((worker: Worker) => any) | ((consoleMessage: PageConsoleMessage) => any)
  ): this {
    if (event === "close") {
      return this.on(event, listener as (worker: Worker) => any);
    }
    return this.on(event, listener as (consoleMessage: PageConsoleMessage) => any);
  }

  removeListener(event: "close", listener: (worker: Worker) => any): this;
  removeListener(event: "console", listener: (consoleMessage: PageConsoleMessage) => any): this;
  removeListener(
    event: "close" | "console",
    listener: ((worker: Worker) => any) | ((consoleMessage: PageConsoleMessage) => any)
  ): this {
    if (event === "close") {
      this.closeListeners.delete(listener as (worker: Worker) => any);
    } else {
      this.consoleListeners.delete(listener as (consoleMessage: PageConsoleMessage) => any);
    }
    return this;
  }

  off(event: "close", listener: (worker: Worker) => any): this;
  off(event: "console", listener: (consoleMessage: PageConsoleMessage) => any): this;
  off(
    event: "close" | "console",
    listener: ((worker: Worker) => any) | ((consoleMessage: PageConsoleMessage) => any)
  ): this {
    if (event === "close") {
      return this.removeListener(event, listener as (worker: Worker) => any);
    }
    return this.removeListener(event, listener as (consoleMessage: PageConsoleMessage) => any);
  }

  prependListener(event: "close", listener: (worker: Worker) => any): this;
  prependListener(event: "console", listener: (consoleMessage: PageConsoleMessage) => any): this;
  prependListener(
    event: "close" | "console",
    listener: ((worker: Worker) => any) | ((consoleMessage: PageConsoleMessage) => any)
  ): this {
    if (event === "close") {
      const reordered = new Set<(worker: Worker) => any>([
        listener as (worker: Worker) => any,
        ...this.closeListeners
      ]);
      this.closeListeners.clear();
      for (const entry of reordered) {
        this.closeListeners.add(entry);
      }
    } else {
      const reordered = new Set<(consoleMessage: PageConsoleMessage) => any>([
        listener as (consoleMessage: PageConsoleMessage) => any,
        ...this.consoleListeners
      ]);
      this.consoleListeners.clear();
      for (const entry of reordered) {
        this.consoleListeners.add(entry);
      }
    }
    return this;
  }

  url(): string {
    return this.delegate?.url() ?? this.workerUrl;
  }

  waitForEvent(
    event: "close",
    optionsOrPredicate?:
      | ((worker: Worker) => boolean | Promise<boolean>)
      | {
          predicate?: (worker: Worker) => boolean | Promise<boolean>;
          timeout?: number;
        }
  ): Promise<Worker>;
  waitForEvent(
    event: "console",
    optionsOrPredicate?:
      | ((consoleMessage: PageConsoleMessage) => boolean | Promise<boolean>)
      | {
          predicate?: (consoleMessage: PageConsoleMessage) => boolean | Promise<boolean>;
          timeout?: number;
        }
  ): Promise<PageConsoleMessage>;
  async waitForEvent(
    event: "close" | "console",
    optionsOrPredicate?:
      | ((worker: Worker) => boolean | Promise<boolean>)
      | ((consoleMessage: PageConsoleMessage) => boolean | Promise<boolean>)
      | {
          predicate?:
            | ((worker: Worker) => boolean | Promise<boolean>)
            | ((consoleMessage: PageConsoleMessage) => boolean | Promise<boolean>);
          timeout?: number;
        }
  ): Promise<Worker | PageConsoleMessage> {
    if (event === "close") {
      return this.waitForWorkerEvent(
        event,
        optionsOrPredicate as
          | ((worker: Worker) => boolean | Promise<boolean>)
          | {
              predicate?: (worker: Worker) => boolean | Promise<boolean>;
              timeout?: number;
            }
      );
    }
    return this.waitForConsoleEvent(
      optionsOrPredicate as
        | ((consoleMessage: PageConsoleMessage) => boolean | Promise<boolean>)
        | {
            predicate?: (consoleMessage: PageConsoleMessage) => boolean | Promise<boolean>;
            timeout?: number;
          }
    );
  }

  emitConsole(message: PageConsoleMessage): void {
    for (const listener of Array.from(this.consoleListeners)) {
      listener(message);
    }
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

  private async waitForWorkerEvent(
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

  private async waitForConsoleEvent(
    optionsOrPredicate?:
      | ((consoleMessage: PageConsoleMessage) => boolean | Promise<boolean>)
      | {
          predicate?: (consoleMessage: PageConsoleMessage) => boolean | Promise<boolean>;
          timeout?: number;
        }
  ): Promise<PageConsoleMessage> {
    const predicate =
      typeof optionsOrPredicate === "function"
        ? optionsOrPredicate
        : optionsOrPredicate?.predicate;
    const timeout =
      typeof optionsOrPredicate === "function"
        ? 30_000
        : optionsOrPredicate?.timeout ?? 30_000;

    return new Promise<PageConsoleMessage>((resolve, reject) => {
      const listener = async (message: PageConsoleMessage) => {
        try {
          const accepted = predicate ? await predicate(message) : true;
          if (!accepted) {
            return;
          }
          clearTimeout(timer);
          this.removeListener("console", listener);
          resolve(message);
        } catch (error) {
          clearTimeout(timer);
          this.removeListener("console", listener);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      };
      const timer = setTimeout(() => {
        this.removeListener("console", listener);
        reject(new TimeoutError(`Timed out waiting for event "console".`));
      }, timeout);
      this.on("console", listener);
    });
  }
}
