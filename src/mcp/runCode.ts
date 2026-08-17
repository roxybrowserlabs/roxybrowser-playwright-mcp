import vm from "node:vm";
import { ManualPromise } from "../vendor/playwright/manualPromise.js";
import type { Page, Request } from "../types/api.js";

export async function runPlaywrightCodeUnsafe(
  page: Page,
  code: string | undefined,
  options: {
    settleMs?: number;
  } = {}
): Promise<string | void> {
  const __end__ = new ManualPromise<string | void>();
  const context: { page: Page; __end__: ManualPromise<string | void>; __fn__?: (page: Page) => unknown } = {
    page,
    __end__
  };
  vm.createContext(context);

  const unhandledRejectionListener = (reason: unknown) => {
    if (!__end__.isDone()) {
      __end__.reject(reason instanceof Error ? reason : new Error(String(reason)));
    }
  };
  const contextErrorSource = page.context() as ReturnType<Page["context"]> & {
    _onUnhandledError?: (listener: (error: Error) => void) => () => void;
  };
  const unsubscribeUnhandledError = contextErrorSource._onUnhandledError?.(unhandledRejectionListener);
  process.on("unhandledRejection", unhandledRejectionListener);
  try {
    await waitForCompletion(page, async () => {
      // Compile the user function separately to avoid template literal escaping issues
      // when the code contains backticks.
      context.__fn__ = vm.runInContext(`(${code})`, context) as (page: Page) => unknown;
      const snippet = `(async () => {
        try {
          const result = await __fn__(page);
          __end__.resolve(JSON.stringify(result));
        } catch (e) {
          __end__.reject(e);
        }
      })()`;
      const iifePromise = vm.runInContext(snippet, context) as Promise<void>;
      await Promise.race([iifePromise, __end__]);
    }, options);
    return await __end__;
  } finally {
    unsubscribeUnhandledError?.();
    process.off("unhandledRejection", unhandledRejectionListener);
  }
}

async function waitForCompletion<R>(
  page: Page,
  callback: () => Promise<R>,
  options: { settleMs?: number } = {}
): Promise<R> {
  const settleMs = options.settleMs ?? 500;
  const requests: Request[] = [];
  const requestListener = (request: Request) => requests.push(request);
  page.on("request", requestListener);

  let result: R;
  try {
    result = await callback();
    await page.waitForTimeout(settleMs);
  } finally {
    page.off("request", requestListener);
  }

  const requestedNavigation = requests.some((request) => request.isNavigationRequest());
  if (requestedNavigation) {
    await page.mainFrame().waitForLoadState("load", { timeout: 10_000 }).catch(() => {});
    return result;
  }

  const promises: Array<Promise<unknown>> = [];
  for (const request of requests) {
    if (["document", "stylesheet", "script", "xhr", "fetch"].includes(request.resourceType())) {
      promises.push(request.response().then((response) => response?.finished()).catch(() => {}));
    } else {
      promises.push(request.response().catch(() => {}));
    }
  }
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, 5_000));
  await Promise.race([Promise.all(promises), timeout]);
  if (requests.length) {
    await page.waitForTimeout(settleMs);
  }
  return result;
}
