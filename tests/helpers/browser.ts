import { chromium } from "../../src/index.js";
import type { Browser, BrowserContext, Page, ResolvedAriaRef } from "../../src/types/api.js";
import {
  cleanupCurrentWorkerTestBrowserProcesses,
  configureCurrentWorkerTestBrowserCleanup
} from "./browser-process-cleanup.js";

const TEST_CLOSE_TIMEOUT_MS = 5_000;
const TEST_LAUNCH_RETRIES = 3;

export type SnapshotPage = Page & {
  resolveAriaRef(ref: string): Promise<ResolvedAriaRef>;
};

export async function withPage<T>(
  run: (page: SnapshotPage, context: BrowserContext, browser: Browser) => Promise<T>
): Promise<T> {
  configureCurrentWorkerTestBrowserCleanup();
  const browser = await launchTestBrowser();

  try {
    const context = await browser.newContext();

    try {
      const page = (await context.newPage()) as SnapshotPage;

      try {
        return await run(page, context, browser);
      } finally {
        await closeForTest("page.close", () => page.close());
      }
    } finally {
      await closeForTest("context.close", () => context.close());
    }
  } finally {
    await closeForTest("browser.close", () => browser.close()).catch(() => {});
    await cleanupCurrentWorkerTestBrowserProcesses();
  }
}

async function launchTestBrowser(): Promise<Browser> {
  let lastError: unknown;
  for (let attempt = 0; attempt < TEST_LAUNCH_RETRIES; attempt += 1) {
    try {
      return await chromium.launch({
        headless: true,
        ...(process.env.ROXY_E2E_EXECUTABLE_PATH
          ? { executablePath: process.env.ROXY_E2E_EXECUTABLE_PATH }
          : {})
      });
    } catch (error) {
      lastError = error;
      if (!isRetriableLaunchError(error) || attempt === TEST_LAUNCH_RETRIES - 1) {
        throw error;
      }
      await cleanupCurrentWorkerTestBrowserProcesses();
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function isRetriableLaunchError(error: unknown): boolean {
  return String(error instanceof Error ? error.message : error).includes("Browser exited before exposing CDP endpoint.");
}

async function closeForTest(label: string, close: () => Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const closePromise = close();
  void closePromise.catch(() => {});
  try {
    await Promise.race([
      closePromise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} timed out after ${TEST_CLOSE_TIMEOUT_MS}ms.`));
        }, TEST_CLOSE_TIMEOUT_MS);
      })
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
