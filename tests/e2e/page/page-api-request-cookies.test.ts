import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium as playwrightChromium } from "playwright";
import { chromium } from "../../../src/index.js";
import {
  buildChromiumLaunchArgs,
  resolveExecutableCandidates,
  waitForDebuggerEndpoint
} from "../../../src/protocol/cdp/backend.js";
import { withPage } from "../../helpers/browser.js";
import { createHistoryPageFixture } from "../../helpers/server.js";

describe("page.request cookies e2e", () => {
  let fixture: Awaited<ReturnType<typeof createHistoryPageFixture>>;

  beforeAll(async () => {
    fixture = await createHistoryPageFixture();
  });

  afterAll(async () => {
    await fixture.close();
  });

  it("shares browser context cookies with API requests in a real Chromium browser", async () => {
    fixture.server.setRoute("/login-cookie", (_request, response) => {
      response.writeHead(200, {
        "content-type": "text/html",
        "set-cookie": [
          "browser_cookie=from-server; Path=/; HttpOnly",
          "js_cookie=from-page; Path=/"
        ]
      });
      response.end("<!doctype html><title>login</title>");
    });
    fixture.server.setRoute("/echo-cookie", (request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ cookie: request.headers.cookie ?? "" }));
    });
    fixture.server.setRoute("/set-cookie-from-api", (_request, response) => {
      response.writeHead(200, {
        "content-type": "application/json",
        "set-cookie": "api_cookie=from-api; Path=/"
      });
      response.end(JSON.stringify({ ok: true }));
    });

    await withPage(async (page) => {
      await page.context().clearCookies();
      await page.goto(`${fixture.server.PREFIX}/login-cookie`, { waitUntil: "load" });
      await page.evaluate("() => { document.cookie = 'client_cookie=from-page; Path=/'; }");

      const response = await page.context().request.get(`${fixture.server.PREFIX}/echo-cookie`);
      const payload = await response.json();
      expect(payload.cookie.split("; ").sort()).toEqual([
        "browser_cookie=from-server",
        "client_cookie=from-page",
        "js_cookie=from-page"
      ]);

      await page.context().request.get(`${fixture.server.PREFIX}/set-cookie-from-api`);
      expect(await page.evaluate("() => document.cookie")).toContain("api_cookie=from-api");
    });
  });

  it("shares cookies from a pre-existing default-context page after chromium.connect", async () => {
    fixture.server.setRoute("/preconnected-login-cookie", (_request, response) => {
      response.writeHead(200, {
        "content-type": "text/html",
        "set-cookie": "preconnected_cookie=from-server; Path=/; HttpOnly"
      });
      response.end("<!doctype html><title>preconnected login</title>");
    });
    fixture.server.setRoute("/preconnected-echo-cookie", (request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ cookie: request.headers.cookie ?? "" }));
    });

    const [chromePath] = resolveExecutableCandidates({
      executablePath: process.env.ROXY_E2E_EXECUTABLE_PATH
    });
    if (!chromePath) {
      throw new Error("No Chrome executable found. Set ROXY_E2E_EXECUTABLE_PATH to a Chrome binary path.");
    }

    const userDataDir = await mkdtemp(join(tmpdir(), "roxy-api-request-cookie-connect-"));
    let chromeProcess: ChildProcess | undefined;
    try {
      chromeProcess = spawn(
        chromePath,
        [
          ...buildChromiumLaunchArgs({ headless: true }, userDataDir).filter(
            arg => arg !== "--no-startup-window"
          ),
          `${fixture.server.PREFIX}/preconnected-login-cookie`
        ],
        { stdio: ["ignore", "pipe", "pipe"] }
      );
      const wsEndpoint = await waitForDebuggerEndpoint(chromeProcess, userDataDir, 15_000);
      const browser = await chromium.connect(wsEndpoint);
      try {
        const context = browser.contexts()[0];
        expect(context).toBeTruthy();
        let page = context.pages().find((candidate) => candidate.url().includes("/preconnected-login-cookie"));
        await vi.waitFor(() => {
          page = context.pages().find((candidate) => candidate.url().includes("/preconnected-login-cookie"));
          expect(page).toBeTruthy();
        });
        await page.waitForLoadState("load");

        const response = await context.request.get(`${fixture.server.PREFIX}/preconnected-echo-cookie`);
        expect(await response.json()).toEqual({
          cookie: "preconnected_cookie=from-server"
        });
      } finally {
        await browser.close();
      }
    } finally {
      chromeProcess?.kill();
      await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("shares cookies already persisted in the browser profile after chromium.connect", async () => {
    fixture.server.setRoute("/persisted-profile-cookie-seed", (_request, response) => {
      response.writeHead(200, {
        "content-type": "text/html",
        "set-cookie": "persisted_cookie=from-profile; Path=/; Max-Age=3600; HttpOnly; SameSite=Lax"
      });
      response.end("<!doctype html><title>persisted profile seed</title>");
    });
    fixture.server.setRoute("/persisted-profile-cookie-echo", (request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ cookie: request.headers.cookie ?? "" }));
    });

    const [chromePath] = resolveExecutableCandidates({
      executablePath: process.env.ROXY_E2E_EXECUTABLE_PATH
    });
    if (!chromePath) {
      throw new Error("No Chrome executable found. Set ROXY_E2E_EXECUTABLE_PATH to a Chrome binary path.");
    }

    const userDataDir = await mkdtemp(join(tmpdir(), "roxy-api-request-persisted-cookie-"));
    let chromeProcess: ChildProcess | undefined;
    try {
      const persistentContext = await playwrightChromium.launchPersistentContext(userDataDir, {
        executablePath: chromePath,
        headless: true
      });
      try {
        const seedPage = await persistentContext.newPage();
        await seedPage.goto(`${fixture.server.PREFIX}/persisted-profile-cookie-seed`, { waitUntil: "load" });
        expect(await persistentContext.cookies(`${fixture.server.PREFIX}/persisted-profile-cookie-echo`)).toEqual([
          expect.objectContaining({
            name: "persisted_cookie",
            value: "from-profile"
          })
        ]);
      } finally {
        await persistentContext.close();
      }

      chromeProcess = spawn(
        chromePath,
        [
          ...buildChromiumLaunchArgs({ headless: true }, userDataDir).filter(
            arg => arg !== "--no-startup-window"
          ),
          "about:blank"
        ],
        { stdio: ["ignore", "pipe", "pipe"] }
      );
      const wsEndpoint = await waitForDebuggerEndpoint(chromeProcess, userDataDir, 15_000);
      const browser = await chromium.connect(wsEndpoint);
      try {
        const context = browser.contexts()[0];
        expect(context).toBeTruthy();
        expect(await context.cookies(`${fixture.server.PREFIX}/persisted-profile-cookie-echo`)).toEqual([
          expect.objectContaining({
            name: "persisted_cookie",
            value: "from-profile"
          })
        ]);

        const response = await context.request.get(`${fixture.server.PREFIX}/persisted-profile-cookie-echo`);
        expect(await response.json()).toEqual({
          cookie: "persisted_cookie=from-profile"
        });
      } finally {
        await Promise.race([
          browser.close(),
          new Promise<void>((resolve) => setTimeout(resolve, 1_000))
        ]);
      }
    } finally {
      chromeProcess?.kill();
      await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("sends cookies injected into the browser context from page.request", async () => {
    fixture.server.setRoute("/injected-cookie-echo", (request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ cookie: request.headers.cookie ?? "" }));
    });

    await withPage(async (page) => {
      await page.context().clearCookies();
      await page.goto(fixture.server.EMPTY_PAGE, { waitUntil: "load" });
      await page.context().addCookies([
        {
          name: "injected_cookie",
          value: "from-context",
          url: `${fixture.server.PREFIX}/injected-cookie-echo`,
          httpOnly: true
        }
      ]);

      const response = await page.context().request.get(`${fixture.server.PREFIX}/injected-cookie-echo`);
      expect(await response.json()).toEqual({
        cookie: "injected_cookie=from-context"
      });
    });
  });

  it("stores Set-Cookie before following redirects from page.request", async () => {
    fixture.server.setRoute("/api-cookie-redirect-start", (_request, response) => {
      response.writeHead(302, {
        location: "/api-cookie-redirect-target",
        "set-cookie": "redirect_cookie=from-api-redirect; Path=/; HttpOnly"
      });
      response.end();
    });
    fixture.server.setRoute("/api-cookie-redirect-target", (request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ cookie: request.headers.cookie ?? "" }));
    });

    await withPage(async (page) => {
      await page.context().clearCookies();
      await page.goto(fixture.server.EMPTY_PAGE, { waitUntil: "load" });
      const response = await page.context().request.get(`${fixture.server.PREFIX}/api-cookie-redirect-start`);
      expect(await response.json()).toEqual({
        cookie: "redirect_cookie=from-api-redirect"
      });
    });
  });
});
