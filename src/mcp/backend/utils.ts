import type { McpRuntime } from "../runtime.js";
import type { Tab } from "./tab.js";

const REQUESTS_WAIT_FOR_FINISH = new Set(["document", "stylesheet", "script", "xhr", "fetch"]);

export async function waitForCompletion<R>(tab: Tab, callback: () => Promise<R>): Promise<R> {
  const requests = await collectRequestsDuringAction(tab, callback);

  const requestedNavigation = requests.requests.some((request) => request.isNavigationRequest);
  if (requestedNavigation) {
    await tab.waitForMainFrameLoad(10_000).catch(() => {});
    return requests.result;
  }

  const promises = requests.requests.map((request) => {
    const waitKey = request.requestKey ?? request.requestId;
    if (REQUESTS_WAIT_FOR_FINISH.has(request.resourceType)) {
      return tab.waitForRequestFinished(waitKey, 5_000).catch(() => {});
    }
    return tab.waitForRequestResponse(waitKey, 5_000).catch(() => {});
  });
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, 5_000));
  await Promise.race([Promise.all(promises), timeout]);
  if (requests.requests.length) {
    await tab.waitForTimeout(500).catch(() => {});
  }

  return requests.result;
}

async function collectRequestsDuringAction<R>(
  tab: Tab,
  callback: () => Promise<R>
): Promise<{ result: R; requests: Awaited<ReturnType<McpRuntime["endRequestCollection"]>> }> {
  const runtime = tab.context.runtime;
  const requestCollectionState = await runtime.beginRequestCollection();
  let requests: Awaited<ReturnType<McpRuntime["endRequestCollection"]>> = [];
  let result: R;
  try {
    result = await callback();
    await tab.waitForTimeout(500);
  } finally {
    requests = await runtime.endRequestCollection(requestCollectionState);
  }
  return { result: result!, requests };
}
