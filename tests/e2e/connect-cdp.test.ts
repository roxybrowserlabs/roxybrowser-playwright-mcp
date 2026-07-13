/**
 * E2E regression tests for chromium.connect().
 *
 * These tests verify two bugs that only manifest against a real Chrome process:
 *
 * Bug #1 — context.pages() was always empty immediately after connect().
 *   Root cause: the page-init Promises created by attachedToTarget event
 *   handlers were fire-and-forget; targetDiscoveryReady resolved before any
 *   pages were registered in pageSet.
 *
 * Bug #2 — page.goto() timed out, and navigation only appeared to complete
 *   after our process exited.
 *   Root cause: waitForDebuggerOnStart: true caused Chrome to pause every new
 *   renderer process (including those spawned by cross-origin navigations).
 *   resumeOnInitialized was only called once at initial attach, so subsequent
 *   navigations hung indefinitely; Chrome auto-resumed when the CDP session
 *   closed on exit.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as cdpModule from "chrome-remote-interface";
import { chromium } from "../../src/index.js";
import {
  buildChromiumLaunchArgs,
  resolveExecutableCandidates,
  waitForDebuggerEndpoint
} from "../../src/protocol/cdp/backend.js";
import { createTestPageFixture } from "../helpers/server.js";

const chromeRemoteInterface = ("default" in cdpModule
  ? cdpModule.default
  : cdpModule) as unknown as (options: {
    target?: string;
  }) => Promise<{
    close(): Promise<void>;
    Target: {
      closeTarget(options: { targetId: string }): Promise<unknown>;
      getTargets(): Promise<{
        targetInfos: Array<{
          targetId: string;
          type: string;
          url: string;
        }>;
      }>;
    };
  }>;

describe("chromium.connect — existing browser", () => {
  let chromeProcess: ChildProcess;
  let userDataDir: string;
  let wsEndpoint: string;
  let fixture: Awaited<ReturnType<typeof createTestPageFixture>>;

  beforeAll(async () => {
    fixture = await createTestPageFixture();

    // Resolve the Chrome executable — respects ROXY_E2E_EXECUTABLE_PATH if set,
    // otherwise falls back to the platform-default candidate paths.
    const [chromePath] = resolveExecutableCandidates({
      executablePath: process.env.ROXY_E2E_EXECUTABLE_PATH
    });
    if (!chromePath) {
      throw new Error(
        "No Chrome executable found. Set ROXY_E2E_EXECUTABLE_PATH to a Chrome binary path."
      );
    }

    userDataDir = await mkdtemp(join(tmpdir(), "roxy-cdp-connect-e2e-"));

    // Pass fixture.url as a positional argument so Chrome opens one real tab in
    // the default browser context. This is the pre-existing page that Bug #1
    // expects context.pages() to discover immediately after connect().
    //
    // buildChromiumLaunchArgs includes --no-startup-window which prevents Chrome
    // from opening any tab on startup (including positional URL arguments). We
    // remove that flag here so the URL argument actually becomes an open tab.
    const args = [
      ...buildChromiumLaunchArgs({ headless: true }, userDataDir).filter(
        arg => arg !== "--no-startup-window"
      ),
      fixture.url
    ];
    chromeProcess = spawn(chromePath, args, {
      stdio: ["ignore", "pipe", "pipe"]
    });

    wsEndpoint = await waitForDebuggerEndpoint(chromeProcess, userDataDir, 15_000);
  });

  afterAll(async () => {
    chromeProcess?.kill();
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
    await fixture.close();
  });

  // Regression test — Bug #1:
  // Before the fix: context.pages() returned [] immediately after connect()
  // even though Chrome had an open tab.
  // After the fix: targetDiscoveryReady now awaits the initial page-init batch,
  // so pages are registered in pageSet before ready() resolves.
  it("context.pages() is non-empty immediately after connect", async () => {
    const browser = await chromium.connect(wsEndpoint);

    try {
      // The default context must be auto-enrolled on connect.
      expect(browser.contexts()).toHaveLength(1);

      // Chrome opened fixture.url on startup — that tab must be visible
      // via pages() without any additional newPage() call.
      expect(browser.contexts()[0].pages().length).toBeGreaterThanOrEqual(1);
    } finally {
      // browser.close() only disconnects the CDP WebSocket; it does NOT kill
      // the Chrome process, so subsequent tests can reconnect to the same browser.
      await browser.close();
    }
  });

  // Regression test — Bug #2:
  // Before the fix: page.goto() hung until our process exited, at which point
  // Chrome auto-resumed (because the debugger detached). With waitForDebuggerOnStart: true,
  // a cross-origin navigation (e.g. about:blank → file://) creates a new renderer
  // process that Chrome pauses and we never unblocked.
  // After the fix: reuseDefaultUserContext contexts use waitForDebuggerOnStart: false,
  // so new renderer processes run freely and goto() completes normally.
  it("page.goto() completes without timeout after connect", async () => {
    const browser = await chromium.connect(wsEndpoint);

    try {
      const context = browser.contexts()[0];

      // Create a new page — starts at about:blank.
      // Navigating from about:blank to a file:// URL is a cross-origin move that
      // Chrome handles by spawning a new renderer process. This is the exact
      // scenario that waitForDebuggerOnStart: true used to block indefinitely.
      const page = await context.newPage();

      try {
        const response = await page.goto(fixture.url, {
          waitUntil: "load",
          timeout: 10_000
        });

        expect(response).toBeDefined();
        expect(await page.title()).toBe("Roxy E2E");
      } finally {
        await page.close().catch(() => {});
      }
    } finally {
      await browser.close();
    }
  });

  it("reconnect reflects tabs closed while disconnected", async () => {
    const browser = await chromium.connect(wsEndpoint);
    const firstMarker = "roxy-disconnect-first";
    const secondMarker = "roxy-disconnect-second";
    const firstUrl = `data:text/html,<title>${firstMarker}</title>`;
    const secondUrl = `data:text/html,<title>${secondMarker}</title>`;

    try {
      const context = browser.contexts()[0];
      const firstPage = await context.newPage();
      const secondPage = await context.newPage();
      await firstPage.goto(firstUrl);
      await secondPage.goto(secondUrl);
    } finally {
      await browser.close();
    }

    const client = await chromeRemoteInterface({ target: wsEndpoint });
    try {
      const targets = await client.Target.getTargets();
      const targetToClose = targets.targetInfos.find(
        target => target.type === "page" && target.url === firstUrl
      );
      expect(targetToClose).toBeDefined();
      await client.Target.closeTarget({ targetId: targetToClose!.targetId });
    } finally {
      await client.close();
    }

    const reconnected = await chromium.connect(wsEndpoint);
    try {
      const urls = reconnected.contexts()[0].pages().map(page => page.url());
      expect(urls).not.toContain(firstUrl);
      expect(urls).toContain(secondUrl);
    } finally {
      await reconnected.close();
    }
  });
});
