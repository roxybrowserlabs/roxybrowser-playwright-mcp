import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "../../src/index.js";
import {
  buildChromiumLaunchArgs,
  resolveExecutableCandidates,
  waitForDebuggerEndpoint
} from "../../src/protocol/cdp/backend.js";
import type { Browser, BrowserContext, Page, ResolvedAriaRef } from "../../src/types/api.js";
import type { LaunchOptions } from "../../src/types/options.js";
import {
  cleanupCurrentWorkerTestBrowserProcesses,
  configureCurrentWorkerTestBrowserCleanup
} from "./browser-process-cleanup.js";

const TEST_CLOSE_TIMEOUT_MS = 5_000;
const TEST_LAUNCH_RETRIES = 3;

export type SnapshotPage = Page & {
  resolveAriaRef(ref: string): Promise<ResolvedAriaRef>;
};

export async function connectTestBrowser(options: LaunchOptions = {}): Promise<Browser> {
  configureCurrentWorkerTestBrowserCleanup();
  let lastError: unknown;
  for (let attempt = 0; attempt < TEST_LAUNCH_RETRIES; attempt += 1) {
    try {
      return await connectTestBrowserOnce({
        headless: true,
        ...(process.env.ROXY_E2E_EXECUTABLE_PATH
          ? { executablePath: process.env.ROXY_E2E_EXECUTABLE_PATH }
          : {}),
        ...options
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

export async function withPage<T>(
  run: (page: SnapshotPage, context: BrowserContext, browser: Browser) => Promise<T>
): Promise<T> {
  configureCurrentWorkerTestBrowserCleanup();
  const browser = await connectTestBrowser();

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

function isRetriableLaunchError(error: unknown): boolean {
  return String(error instanceof Error ? error.message : error).includes("Browser exited before exposing CDP endpoint.");
}

async function connectTestBrowserOnce(options: LaunchOptions): Promise<Browser> {
  const userDataDir = await mkdtemp(join(tmpdir(), "roxybrowser-cdp-"));
  const [chromePath] = resolveExecutableCandidates(options);
  if (!chromePath) {
    throw new Error("No Chrome executable found. Set ROXY_E2E_EXECUTABLE_PATH to a Chrome binary path.");
  }
  const chromeProcess = spawn(chromePath, buildChromiumLaunchArgs(options, userDataDir), {
    stdio: ["ignore", "pipe", "pipe"]
  });

  try {
    const wsEndpoint = await waitForDebuggerEndpoint(chromeProcess, userDataDir, 15_000);
    const browser = await chromium.connect(wsEndpoint);
    return wrapBrowserCleanup(browser, chromeProcess, userDataDir);
  } catch (error) {
    chromeProcess.kill();
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

function wrapBrowserCleanup(browser: Browser, chromeProcess: ChildProcess, userDataDir: string): Browser {
  const close = browser.close.bind(browser);
  let closed = false;
  browser.close = async (options?: { reason?: string }) => {
    if (closed) {
      return;
    }
    closed = true;
    try {
      await close(options);
    } finally {
      chromeProcess.kill();
      await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
    }
  };
  return browser;
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
