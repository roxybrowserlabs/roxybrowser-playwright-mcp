import { afterAll } from "vitest";
import { firefox } from "../../src/index.js";
import type { Browser, BrowserContext, Page } from "../../src/types/api.js";
import {
  parseNumber,
  resolveRoxyBrowserEndpoint,
  toBidiWsEndpoint
} from "./roxybrowser.js";

const FIREFOX_EXECUTABLE =
  process.env.ROXY_BIDI_EXECUTABLE_PATH ?? "/Applications/Firefox.app/Contents/MacOS/firefox";
const BIDI_WS_ENDPOINT = process.env.ROXY_BIDI_WS_ENDPOINT;
const BIDI_SESSION_ID = process.env.ROXY_BIDI_SESSION_ID;
const ROXYBROWSER_API_PORT = process.env.ROXYBROWSER_API_PORT ?? process.env.ROXY_API_PORT ?? "50000";
const ROXYBROWSER_API_TOKEN = process.env.ROXYBROWSER_API_TOKEN ?? process.env.ROXY_API_TOKEN;
const ROXYBROWSER_WORKSPACE_ID = process.env.ROXYBROWSER_WORKSPACE_ID;
const ROXYBROWSER_PROJECT_ID = process.env.ROXYBROWSER_PROJECT_ID;
const ROXYBROWSER_PROFILE_ID = process.env.ROXYBROWSER_PROFILE_ID;
const ROXYBROWSER_PROFILE_NAME = process.env.ROXYBROWSER_PROFILE_NAME ?? "RoxyBrowser Firefox BiDi E2E";
const ROXYBROWSER_PROFILE_MATCH = process.env.ROXYBROWSER_PROFILE_MATCH ?? "firefox";
const ROXYBROWSER_DEBUG = process.env.ROXYBROWSER_DEBUG === "1";
const ROXYBROWSER_API_RETRIES = parseNumber(process.env.ROXYBROWSER_API_RETRIES) ?? 2;
const ROXYBROWSER_FORCE_OPEN = process.env.ROXYBROWSER_FORCE_OPEN !== "0";

let usesExternalBidiEndpoint = false;
let externalBidiBrowser: Browser | undefined;
let externalBidiBrowserKey: string | undefined;

afterAll(async () => {
  await closeExternalBidiBrowser();
});

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
    if (externalBidiBrowser && externalBidiBrowserKey === browserKey) {
      return externalBidiBrowser;
    }

    await closeExternalBidiBrowser();
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

  return resolveRoxyBrowserEndpoint({
    protocol: "bidi",
    apiPort: ROXYBROWSER_API_PORT,
    apiToken: ROXYBROWSER_API_TOKEN,
    workspaceId: ROXYBROWSER_WORKSPACE_ID,
    projectId: ROXYBROWSER_PROJECT_ID,
    profileId: ROXYBROWSER_PROFILE_ID,
    profileName: ROXYBROWSER_PROFILE_NAME,
    profileMatch: ROXYBROWSER_PROFILE_MATCH,
    browserType: "firefox",
    coreType: "firefox",
    windowRemark: "firefox bidi e2e",
    createProfileJsonEnv: "ROXYBROWSER_CREATE_PROFILE_JSON",
    debug: ROXYBROWSER_DEBUG,
    debugScope: "roxybrowser:e2e:bidi",
    retries: ROXYBROWSER_API_RETRIES,
    forceOpen: ROXYBROWSER_FORCE_OPEN,
    headless: false,
    useSingleProfileFallback: true,
    createMissingProfile: true
  });
}

export async function withBidiPage<T>(
  run: (page: Page, context: BrowserContext, browser: Browser) => Promise<T>
): Promise<T> {
  const browser = await openBidiBrowser();
  const keepBrowserOpen = usesExternalBidiEndpoint;

  try {
    const context = await browser.newContext(
      usesExternalBidiEndpoint
        ? {
            reuseDefaultUserContext: true
          }
        : {}
    );

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
