import { firefox } from "../../src/index.js";
import type { Browser, BrowserContext, Page } from "../../src/types/api.js";
import {
  closeRoxyBrowserFirefoxBidiProfile,
  openRoxyBrowserFirefoxBidiProfile
} from "../../scripts/roxybrowser-firefox-bidi.mjs";
import {
  cleanupCurrentWorkerTestBrowserProcesses,
  cleanupCurrentWorkerTestBrowserProcessesSync,
  configureCurrentWorkerTestBrowserCleanup
} from "./browser-process-cleanup.js";

const BIDI_SESSION_ID = process.env.ROXY_BIDI_SESSION_ID;
const ROXYBROWSER_API_PORT = process.env.ROXYBROWSER_API_PORT ?? process.env.ROXY_API_PORT ?? "50000";
const ROXYBROWSER_API_TOKEN = process.env.ROXYBROWSER_API_TOKEN ?? process.env.ROXY_API_TOKEN;
const ROXYBROWSER_WORKSPACE_ID = process.env.ROXYBROWSER_WORKSPACE_ID;
const ROXYBROWSER_PROJECT_ID = process.env.ROXYBROWSER_PROJECT_ID;
const ROXYBROWSER_PROFILE_ID = process.env.ROXYBROWSER_PROFILE_ID;
const ROXYBROWSER_PROFILE_NAME = process.env.ROXYBROWSER_PROFILE_NAME ?? "RoxyBrowser Firefox BiDi E2E";
const ROXYBROWSER_PROFILE_MATCH = process.env.ROXYBROWSER_PROFILE_MATCH ?? "firefox";
const ROXYBROWSER_CORE_VERSION = process.env.ROXYBROWSER_CORE_VERSION ?? "146";
const ROXYBROWSER_DEBUG = process.env.ROXYBROWSER_DEBUG === "1";
const REUSE_BIDI_BROWSER = process.env.ROXY_BIDI_REUSE_BROWSER !== "0";
const TEST_CLOSE_TIMEOUT_MS = 5_000;
const SIGNAL_EXIT_GRACE_MS = Number(process.env.ROXY_TEST_BROWSER_SIGNAL_EXIT_GRACE_MS ?? 20_000);

interface BidiTestState {
  browser: Browser | undefined;
  browserKey: string | undefined;
  roxyProfileDirId: string | undefined;
  roxyProfileWasCreated: boolean;
}

function bidiTestState(): BidiTestState {
  const state = globalThis as typeof globalThis & {
    __roxyBidiTestState?: BidiTestState;
  };
  state.__roxyBidiTestState ??= {
    browser: undefined,
    browserKey: undefined,
    roxyProfileDirId: undefined,
    roxyProfileWasCreated: false
  };
  return state.__roxyBidiTestState;
}

function workerLabel(): string {
  return process.env.VITEST_POOL_ID ?? "main";
}

function workerWindowRemark(): string {
  return `firefox bidi e2e worker-${workerLabel()}`;
}

function workerProfileName(): string {
  return `${ROXYBROWSER_PROFILE_NAME} [worker ${workerLabel()}]`;
}

function bidiHumanOptions() {
  return {
    hoverBeforeClickMs: 0,
    clickHoldMs: 0,
    typingDelayMs: 0,
    typingVarianceMs: 0
  };
}

function assertRoxyBrowserBidiEnvironment(): void {
  if (!ROXYBROWSER_API_TOKEN) {
    throw new Error(
      "BiDi e2e now requires RoxyBrowser. Set ROXYBROWSER_API_TOKEN or ROXY_API_TOKEN."
    );
  }
}

async function openWorkerScopedRoxyBrowserSession(): Promise<{ dirId: string; endpoint: string; created?: boolean }> {
  assertRoxyBrowserBidiEnvironment();
  return openRoxyBrowserFirefoxBidiProfile({
    apiPort: ROXYBROWSER_API_PORT,
    apiToken: ROXYBROWSER_API_TOKEN,
    workspaceId: ROXYBROWSER_WORKSPACE_ID,
    projectId: ROXYBROWSER_PROJECT_ID,
    ...(ROXYBROWSER_PROFILE_ID ? { profileId: ROXYBROWSER_PROFILE_ID } : { createNewProfile: true }),
    profileName: workerProfileName(),
    profileMatch: ROXYBROWSER_PROFILE_MATCH,
    coreType: "Firefox",
    coreVersion: ROXYBROWSER_CORE_VERSION,
    windowRemark: workerWindowRemark(),
    debug: ROXYBROWSER_DEBUG,
    os: process.env.ROXYBROWSER_OS ?? "macOS",
    osVersion: process.env.ROXYBROWSER_OS_VERSION
  });
}

function shouldReuseBidiBrowser(): boolean {
  return REUSE_BIDI_BROWSER;
}

export async function openBidiBrowser(): Promise<Browser> {
  configureCurrentWorkerTestBrowserCleanup();
  const state = bidiTestState();

  if (shouldReuseBidiBrowser() && state.browser) {
    return state.browser;
  }

  await cleanupStaleBidiTestArtifacts();

  const session = await openWorkerScopedRoxyBrowserSession();
  const browserKey = `${session.dirId}:${session.endpoint}:${BIDI_SESSION_ID ?? ""}`;
  const browser = await firefox.connect({
    browserName: "firefox",
    protocol: "bidi",
    wsEndpoint: session.endpoint,
    ...(BIDI_SESSION_ID ? { sessionId: BIDI_SESSION_ID } : {}),
    human: bidiHumanOptions()
  });

  state.roxyProfileDirId = session.dirId;
  state.roxyProfileWasCreated = Boolean(session.created);

  if (shouldReuseBidiBrowser()) {
    state.browser = browser;
    state.browserKey = browserKey;
  }

  return browser;
}

export async function withBidiPage<T>(
  run: (page: Page, context: BrowserContext, browser: Browser) => Promise<T>
): Promise<T> {
  const shouldReuseBrowser = shouldReuseBidiBrowser();
  let browser = await openBidiBrowser();
  let context: BrowserContext | undefined;

  try {
    context = await browser.newContext({ reuseDefaultUserContext: true });
  } catch (error) {
    if (!isRecoverableBidiBrowserError(error)) {
      throw error;
    }

    await cleanupExternalBidiTestState();
    browser = await openBidiBrowser();
    context = await browser.newContext({ reuseDefaultUserContext: true });
  }

  try {
    const page = await context.newPage();

    try {
      return await run(page, context, browser);
    } finally {
      await closeForTest("page.close", () => page.close()).catch(() => {});
    }
  } finally {
    await closeForTest("context.close", () => context.close()).catch(() => {});
    if (!shouldReuseBrowser) {
      await closeForTest("browser.close", () => browser.close()).catch(() => {});
      await cleanupStaleBidiTestArtifacts();
    }
  }
}

function isClosedBidiConnectionError(error: unknown): boolean {
  return String(error instanceof Error ? error.message : error).includes(
    "WebDriver BiDi connection is closed."
  );
}

function isRecoverableBidiBrowserError(error: unknown): boolean {
  const message = String(error instanceof Error ? error.message : error);
  return (
    isClosedBidiConnectionError(error)
    || message.includes("Target page, context or browser has been closed")
    || message.includes("Session closed")
  );
}

async function cleanupStaleBidiTestArtifacts(): Promise<void> {
  const state = bidiTestState();
  const dirId = state.roxyProfileDirId;
  const deleteProfile = state.roxyProfileWasCreated;
  state.roxyProfileDirId = undefined;
  state.roxyProfileWasCreated = false;
  if (dirId) {
    await closeRoxyBrowserFirefoxBidiProfile({
      apiPort: ROXYBROWSER_API_PORT,
      apiToken: ROXYBROWSER_API_TOKEN,
      workspaceId: ROXYBROWSER_WORKSPACE_ID,
      dirId,
      deleteProfile
    });
  }
  await cleanupCurrentWorkerTestBrowserProcesses();
}

export async function cleanupExternalBidiTestState(): Promise<void> {
  const state = bidiTestState();
  const browser = state.browser;
  state.browser = undefined;
  state.browserKey = undefined;

  if (browser) {
    await closeForTest("browser.close", () => browser.close()).catch(() => {});
  }

  await cleanupStaleBidiTestArtifacts();
}

export async function cleanupBidiTestStateAfterTest(): Promise<void> {
  if (!shouldReuseBidiBrowser()) {
    return;
  }

  await delay(0);
}

export async function cleanupLocalBidiTestProcesses(): Promise<void> {
  await cleanupCurrentWorkerTestBrowserProcesses();
}

export function installBidiTestCleanupHooks(): void {
  const state = globalThis as typeof globalThis & {
    __roxyBidiTestCleanupHooksInstalled?: boolean;
  };
  if (state.__roxyBidiTestCleanupHooksInstalled) {
    return;
  }
  state.__roxyBidiTestCleanupHooksInstalled = true;

  process.once("exit", () => {
    cleanupCurrentWorkerTestBrowserProcessesSync();
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      const exitCode = signal === "SIGINT" ? 130 : 143;
      const fallback = setTimeout(() => {
        process.exit(exitCode);
      }, SIGNAL_EXIT_GRACE_MS);

      void cleanupExternalBidiTestState()
        .catch(() => {})
        .finally(() => {
          clearTimeout(fallback);
          process.exit(exitCode);
        });
    });
  }

  process.once("uncaughtException", (error) => {
    const fallback = setTimeout(() => {
      throw error;
    }, SIGNAL_EXIT_GRACE_MS);

    void cleanupExternalBidiTestState()
      .catch(() => {})
      .finally(() => {
        clearTimeout(fallback);
        setTimeout(() => {
          throw error;
        }, 0);
      });
  });

  process.once("unhandledRejection", (reason) => {
    const fallback = setTimeout(() => {
      throw reason;
    }, SIGNAL_EXIT_GRACE_MS);

    void cleanupExternalBidiTestState()
      .catch(() => {})
      .finally(() => {
        clearTimeout(fallback);
        setTimeout(() => {
          throw reason;
        }, 0);
      });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
