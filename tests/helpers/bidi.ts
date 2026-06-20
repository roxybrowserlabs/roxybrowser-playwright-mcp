import { firefox } from "../../src/index.js";
import type { Browser, BrowserContext, Page } from "../../src/types/api.js";
import {
  closeRoxyBrowserFirefoxBidiProfile,
  resolveRoxyBrowserFirefoxBidiEndpoint
} from "../../scripts/roxybrowser-firefox-bidi.mjs";
import {
  toBidiWsEndpoint
} from "./roxybrowser.js";
import { cleanupLocalTestBrowserProcessesWithTimeout } from "./browser-process-cleanup.js";

const FIREFOX_EXECUTABLE =
  process.env.ROXY_BIDI_EXECUTABLE_PATH
  ?? process.env.ROXY_EXECUTABLE_PATH
  ?? "/Applications/Firefox.app/Contents/MacOS/firefox";
const BIDI_WS_ENDPOINT = process.env.ROXY_BIDI_WS_ENDPOINT;
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
const USE_ROXYBROWSER_API = process.env.ROXY_BIDI_USE_ROXYBROWSER_API === "1";
const KEEP_BIDI_BROWSER_OPEN =
  process.env.ROXY_BIDI_KEEP_BROWSER_OPEN === "1" && Boolean(BIDI_WS_ENDPOINT);
const REUSE_EXTERNAL_BIDI_BROWSER = process.env.ROXY_BIDI_REUSE_BROWSER === "1";
const TEST_CLOSE_TIMEOUT_MS = 5_000;
const SIGNAL_EXIT_GRACE_MS = Number(process.env.ROXY_TEST_BROWSER_SIGNAL_EXIT_GRACE_MS ?? 20_000);

let usesExternalBidiEndpoint = false;
let externalBidiBrowser: Browser | undefined;
let externalBidiBrowserKey: string | undefined;
let cachedRoxyBrowserEndpoint: string | undefined;

function bidiHumanOptions() {
  return {
    hoverBeforeClickMs: 0,
    clickHoldMs: 0,
    typingDelayMs: 0,
    typingVarianceMs: 0
  };
}

export async function openBidiBrowser(): Promise<Browser> {
  if (!shouldKeepConfiguredExternalBidiBrowserOpen()) {
    await cleanupExternalBidiTestState();
  }

  const roxyBrowserEndpoint = BIDI_WS_ENDPOINT
    ? toBidiWsEndpoint(BIDI_WS_ENDPOINT)
    : await resolveRoxyBrowserBidiEndpoint();

  if (roxyBrowserEndpoint) {
    usesExternalBidiEndpoint = true;

    const browserKey = `${roxyBrowserEndpoint}#${BIDI_SESSION_ID ?? ""}`;
    if (
      REUSE_EXTERNAL_BIDI_BROWSER
      && externalBidiBrowser
      && externalBidiBrowserKey === browserKey
    ) {
      return externalBidiBrowser;
    }

    if (REUSE_EXTERNAL_BIDI_BROWSER) {
      await closeExternalBidiBrowser();
    }
    externalBidiBrowserKey = browserKey;
    externalBidiBrowser = await firefox.connect({
      browserName: "firefox",
      protocol: "bidi",
      wsEndpoint: roxyBrowserEndpoint,
      ...(BIDI_SESSION_ID ? { sessionId: BIDI_SESSION_ID } : {}),
      human: bidiHumanOptions()
    });
    return externalBidiBrowser;
  }

  usesExternalBidiEndpoint = false;

  return firefox.launch({
    headless: true,
    executablePath: FIREFOX_EXECUTABLE,
    human: bidiHumanOptions()
  });
}

async function resolveRoxyBrowserBidiEndpoint(): Promise<string | undefined> {
  if (!USE_ROXYBROWSER_API || !ROXYBROWSER_API_TOKEN) {
    return undefined;
  }

  if (cachedRoxyBrowserEndpoint) {
    return cachedRoxyBrowserEndpoint;
  }

  cachedRoxyBrowserEndpoint = await resolveRoxyBrowserFirefoxBidiEndpoint({
    apiPort: ROXYBROWSER_API_PORT,
    apiToken: ROXYBROWSER_API_TOKEN,
    workspaceId: ROXYBROWSER_WORKSPACE_ID,
    projectId: ROXYBROWSER_PROJECT_ID,
    profileId: ROXYBROWSER_PROFILE_ID,
    profileName: ROXYBROWSER_PROFILE_NAME,
    profileMatch: ROXYBROWSER_PROFILE_MATCH,
    coreType: "Firefox",
    coreVersion: ROXYBROWSER_CORE_VERSION,
    windowRemark: "firefox bidi e2e",
    debug: ROXYBROWSER_DEBUG,
    os: process.env.ROXYBROWSER_OS ?? "macOS",
    osVersion: process.env.ROXYBROWSER_OS_VERSION
  });

  return cachedRoxyBrowserEndpoint;
}

export async function withBidiPage<T>(
  run: (page: Page, context: BrowserContext, browser: Browser) => Promise<T>
): Promise<T> {
  let browser = await openBidiBrowser();
  const keepBrowserOpen = shouldKeepExternalBidiBrowserOpen();
  let context: BrowserContext | undefined;

  try {
    try {
      context = await browser.newContext({});
    } catch (error) {
      if (!keepBrowserOpen || !isClosedBidiConnectionError(error)) {
        throw error;
      }

      await resetExternalBidiBrowserState();
      browser = await openBidiBrowser();
      context = await browser.newContext({});
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
    }
  } finally {
    if (!keepBrowserOpen) {
      await closeForTest("browser.close", () => browser.close()).catch(() => {});
      if (usesExternalBidiEndpoint) {
        externalBidiBrowser = undefined;
        externalBidiBrowserKey = undefined;
        cachedRoxyBrowserEndpoint = undefined;
        await closeRoxyBrowserFirefoxBidiProfile({
          apiPort: ROXYBROWSER_API_PORT,
          apiToken: ROXYBROWSER_API_TOKEN,
          workspaceId: ROXYBROWSER_WORKSPACE_ID,
          projectId: ROXYBROWSER_PROJECT_ID,
          profileId: ROXYBROWSER_PROFILE_ID,
          coreType: "Firefox",
          coreVersion: ROXYBROWSER_CORE_VERSION,
          windowRemark: "firefox bidi e2e"
        });
      }
      await cleanupLocalTestBrowserProcessesWithTimeout();
    }
  }
}

function shouldKeepExternalBidiBrowserOpen(): boolean {
  if (!usesExternalBidiEndpoint) {
    return false;
  }

  return shouldKeepConfiguredExternalBidiBrowserOpen();
}

function shouldKeepConfiguredExternalBidiBrowserOpen(): boolean {
  return Boolean(BIDI_WS_ENDPOINT) && (KEEP_BIDI_BROWSER_OPEN || REUSE_EXTERNAL_BIDI_BROWSER);
}

async function closeExternalBidiBrowser(): Promise<void> {
  const browser = externalBidiBrowser;
  usesExternalBidiEndpoint = false;
  externalBidiBrowser = undefined;
  externalBidiBrowserKey = undefined;

  if (!browser) {
    return;
  }

  await closeForTest("browser.close", () => browser.close()).catch(() => {});
  await delay(250);
}

async function resetExternalBidiBrowserState(): Promise<void> {
  await cleanupExternalBidiTestState();
  await delay(500);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isClosedBidiConnectionError(error: unknown): boolean {
  return String(error instanceof Error ? error.message : error).includes(
    "WebDriver BiDi connection is closed."
  );
}

export async function cleanupExternalBidiTestState(): Promise<void> {
  usesExternalBidiEndpoint = false;
  await closeExternalBidiBrowser();
  cachedRoxyBrowserEndpoint = undefined;
  await closeRoxyBrowserFirefoxBidiProfile({
    apiPort: ROXYBROWSER_API_PORT,
    apiToken: ROXYBROWSER_API_TOKEN,
    workspaceId: ROXYBROWSER_WORKSPACE_ID,
    projectId: ROXYBROWSER_PROJECT_ID,
    profileId: ROXYBROWSER_PROFILE_ID,
    coreType: "Firefox",
    coreVersion: ROXYBROWSER_CORE_VERSION,
    windowRemark: "firefox bidi e2e"
  });
  await cleanupLocalTestBrowserProcessesWithTimeout();
}

export async function cleanupBidiTestStateAfterTest(): Promise<void> {
  if (shouldKeepExternalBidiBrowserOpen()) {
    return;
  }

  await cleanupExternalBidiTestState();
}

export async function cleanupLocalBidiTestProcesses(): Promise<void> {
  await cleanupLocalTestBrowserProcessesWithTimeout();
}

export function installBidiTestCleanupHooks(): void {
  const state = globalThis as typeof globalThis & {
    __roxyBidiTestCleanupHooksInstalled?: boolean;
  };
  if (state.__roxyBidiTestCleanupHooksInstalled) {
    return;
  }
  state.__roxyBidiTestCleanupHooksInstalled = true;

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
