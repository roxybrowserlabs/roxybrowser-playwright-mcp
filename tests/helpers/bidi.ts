import { firefox } from "../../src/index.js";
import type { Browser, BrowserContext, Page } from "../../src/types/api.js";
import {
  closeRoxyBrowserFirefoxBidiProfile,
  resolveRoxyBrowserFirefoxBidiEndpoint
} from "../../scripts/roxybrowser-firefox-bidi.mjs";
import {
  toBidiWsEndpoint
} from "./roxybrowser.js";
import { cleanupLocalTestBrowserProcesses } from "./browser-process-cleanup.js";

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
const KEEP_BIDI_BROWSER_OPEN = process.env.ROXY_BIDI_KEEP_BROWSER_OPEN === "1";

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
  const roxyBrowserEndpoint = BIDI_WS_ENDPOINT
    ? toBidiWsEndpoint(BIDI_WS_ENDPOINT)
    : await resolveRoxyBrowserBidiEndpoint();

  if (roxyBrowserEndpoint) {
    usesExternalBidiEndpoint = true;

    const browserKey = `${roxyBrowserEndpoint}#${BIDI_SESSION_ID ?? ""}`;
    if (KEEP_BIDI_BROWSER_OPEN && externalBidiBrowser && externalBidiBrowserKey === browserKey) {
      return externalBidiBrowser;
    }

    if (KEEP_BIDI_BROWSER_OPEN) {
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
  if (!ROXYBROWSER_API_TOKEN) {
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
  const keepBrowserOpen = usesExternalBidiEndpoint && KEEP_BIDI_BROWSER_OPEN;
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
        await page.close();
      }
    } finally {
      await context.close();
    }
  } finally {
    if (!keepBrowserOpen) {
      await browser.close();
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
    }
  }
}

async function closeExternalBidiBrowser(): Promise<void> {
  const browser = externalBidiBrowser;
  externalBidiBrowser = undefined;
  externalBidiBrowserKey = undefined;

  if (!browser) {
    return;
  }

  await browser.close().catch(() => {});
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
  await cleanupLocalTestBrowserProcesses();
}

export async function cleanupLocalBidiTestProcesses(): Promise<void> {
  await cleanupLocalTestBrowserProcesses();
}
