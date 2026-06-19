import { chromium } from "../../src/index.js";
import type { Browser, BrowserContext, Page, ResolvedAriaRef } from "../../src/types/api.js";
import { cleanupLocalTestBrowserProcessesWithTimeout } from "./browser-process-cleanup.js";

const TEST_CLOSE_TIMEOUT_MS = 5_000;

export type SnapshotPage = Page & {
  resolveAriaRef(ref: string): Promise<ResolvedAriaRef>;
};

export async function withPage<T>(
  run: (page: SnapshotPage, context: BrowserContext, browser: Browser) => Promise<T>
): Promise<T> {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.ROXY_E2E_EXECUTABLE_PATH
      ? { executablePath: process.env.ROXY_E2E_EXECUTABLE_PATH }
      : {})
  });

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
    await cleanupLocalTestBrowserProcessesWithTimeout();
  }
}

async function closeForTest(label: string, close: () => Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      close(),
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
