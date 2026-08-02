import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { firefox } from "../../../../src/index.js";
import { withBidiPage } from "../../../helpers/bidi.js";
import { createHistoryPageFixture } from "../../../helpers/server.js";
import {
  closeRoxyBrowserFirefoxBidiProfile,
  openRoxyBrowserFirefoxBidiProfile
} from "../../../../scripts/roxybrowser-firefox-bidi.mjs";

describe("page.request cookies e2e (bidi/firefox)", () => {
  let fixture: Awaited<ReturnType<typeof createHistoryPageFixture>>;

  beforeAll(async () => {
    fixture = await createHistoryPageFixture();
  });

  afterAll(async () => {
    await fixture.close();
  });

  it("shares browser context cookies with API requests in a real Firefox BiDi browser", async () => {
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

    await withBidiPage(async (page) => {
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

  it("sends cookies injected into the browser context from page.request", async () => {
    fixture.server.setRoute("/bidi-injected-cookie-echo", (request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ cookie: request.headers.cookie ?? "" }));
    });

    await withBidiPage(async (page) => {
      await page.context().clearCookies();
      await page.goto(fixture.server.EMPTY_PAGE, { waitUntil: "load" });
      await page.context().addCookies([
        {
          name: "injected_cookie",
          value: "from-context",
          url: `${fixture.server.PREFIX}/bidi-injected-cookie-echo`,
          httpOnly: true
        }
      ]);

      const response = await page.context().request.get(`${fixture.server.PREFIX}/bidi-injected-cookie-echo`);
      expect(await response.json()).toEqual({
        cookie: "injected_cookie=from-context"
      });
    });
  });

  it("stores Set-Cookie before following redirects from page.request", async () => {
    fixture.server.setRoute("/bidi-api-cookie-redirect-start", (_request, response) => {
      response.writeHead(302, {
        location: "/bidi-api-cookie-redirect-target",
        "set-cookie": "redirect_cookie=from-api-redirect; Path=/; HttpOnly"
      });
      response.end();
    });
    fixture.server.setRoute("/bidi-api-cookie-redirect-target", (request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ cookie: request.headers.cookie ?? "" }));
    });

    await withBidiPage(async (page) => {
      await page.context().clearCookies();
      await page.goto(fixture.server.EMPTY_PAGE, { waitUntil: "load" });
      const response = await page.context().request.get(`${fixture.server.PREFIX}/bidi-api-cookie-redirect-start`);
      expect(await response.json()).toEqual({
        cookie: "redirect_cookie=from-api-redirect"
      });
    });
  });

  it("shares cookies already persisted in the Firefox profile after firefox.connect", async () => {
    fixture.server.setRoute("/bidi-persisted-profile-cookie-seed", (_request, response) => {
      response.writeHead(200, {
        "content-type": "text/html",
        "set-cookie": "bidi_persisted_cookie=from-profile; Path=/; Max-Age=3600; HttpOnly; SameSite=Lax"
      });
      response.end("<!doctype html><title>bidi persisted profile seed</title>");
    });
    fixture.server.setRoute("/bidi-persisted-profile-cookie-echo", (request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ cookie: request.headers.cookie ?? "" }));
    });

    const profileName = `RoxyBrowser Firefox BiDi persisted cookie ${Date.now()}`;
    const windowRemark = `${profileName} remark`;
    let dirId: string | undefined;
    let seedBrowser: Awaited<ReturnType<typeof firefox.connect>> | undefined;
    let reopenedBrowser: Awaited<ReturnType<typeof firefox.connect>> | undefined;

    try {
      const seedSession = await openRoxyBrowserFirefoxBidiProfile({
        createNewProfile: true,
        profileName,
        windowRemark
      });
      dirId = seedSession.dirId;
      seedBrowser = await firefox.connect(seedSession.endpoint, {
        ...(seedSession.sessionId ? { sessionId: seedSession.sessionId } : {})
      });
      const seedContext = seedBrowser.contexts()[0] ?? await seedBrowser.newContext({ reuseDefaultUserContext: true });
      const seedPage = await seedContext.newPage();
      try {
        await seedPage.goto(`${fixture.server.PREFIX}/bidi-persisted-profile-cookie-seed`, { waitUntil: "load" });
        expect(await seedContext.cookies(`${fixture.server.PREFIX}/bidi-persisted-profile-cookie-echo`)).toEqual([
          expect.objectContaining({
            name: "bidi_persisted_cookie",
            value: "from-profile"
          })
        ]);
      } finally {
        await seedPage.close().catch(() => {});
      }
      await seedBrowser.close();
      seedBrowser = undefined;
      await closeRoxyBrowserFirefoxBidiProfile({ dirId });

      const reopenedSession = await openRoxyBrowserFirefoxBidiProfile({
        profileId: dirId,
        profileName,
        windowRemark
      });
      reopenedBrowser = await firefox.connect(reopenedSession.endpoint, {
        ...(reopenedSession.sessionId ? { sessionId: reopenedSession.sessionId } : {})
      });
      const reopenedContext =
        reopenedBrowser.contexts()[0] ?? await reopenedBrowser.newContext({ reuseDefaultUserContext: true });
      expect(await reopenedContext.cookies(`${fixture.server.PREFIX}/bidi-persisted-profile-cookie-echo`)).toEqual([
        expect.objectContaining({
          name: "bidi_persisted_cookie",
          value: "from-profile"
        })
      ]);

      const response = await reopenedContext.request.get(`${fixture.server.PREFIX}/bidi-persisted-profile-cookie-echo`);
      expect(await response.json()).toEqual({
        cookie: "bidi_persisted_cookie=from-profile"
      });
    } finally {
      await reopenedBrowser?.close().catch(() => {});
      await seedBrowser?.close().catch(() => {});
      if (dirId) {
        await closeRoxyBrowserFirefoxBidiProfile({ dirId, deleteProfile: true });
      }
    }
  });
});
