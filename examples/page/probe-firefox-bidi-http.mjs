import { createServer } from "node:http";
import { firefox } from "@roxybrowser/playwright";
import { createExampleFixture } from "./helpers/fixture.mjs";

const wsEndpoint = process.env.ROXY_BIDI_ENDPOINT ?? process.env.ROXY_BIDI_WS_ENDPOINT;
const reuseDefaultUserContext = process.env.ROXY_BIDI_REUSE_DEFAULT_USER_CONTEXT === "1";

if (!wsEndpoint) {
  console.error("Missing ROXY_BIDI_ENDPOINT.");
  console.error("Example:");
  console.error("  ROXY_BIDI_ENDPOINT=ws://127.0.0.1:9222/session pnpm examples page probe-firefox-bidi-http");
  process.exit(1);
}

function createProbeServer() {
  const server = createServer((request, response) => {
    if (request.url === "/simple.json") {
      response.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-cache, no-store"
      });
      response.end('{"foo":"bar"}\n');
      return;
    }

    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-cache, no-store"
    });
    response.end("<!doctype html><title>probe</title><body>probe</body>");
  });

  return {
    async start() {
      await new Promise((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
      });

      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Failed to start probe server.");
      }

      return {
        url: `http://127.0.0.1:${address.port}/simple.json`
      };
    },
    async close() {
      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  };
}

async function closeQuietly(resource, label) {
  if (!resource) {
    return;
  }

  try {
    await resource.close();
  } catch (error) {
    console.error(`Failed to close ${label}.`);
    console.error(error);
  }
}

async function run() {
  const fixture = await createExampleFixture();
  const probeServer = createProbeServer();
  const { url: httpUrl } = await probeServer.start();

  let browser;
  let context;
  let page;

  try {
    console.log("BiDi probe starting...");
    console.log("wsEndpoint:", wsEndpoint);
    console.log("reuseDefaultUserContext:", reuseDefaultUserContext);
    console.log("fileUrl:", fixture.url);
    console.log("httpUrl:", httpUrl);

    browser = await firefox.connect(wsEndpoint);

    console.log("browserVersion:", await browser.version());

    context = await browser.newContext(
      reuseDefaultUserContext
        ? {
            reuseDefaultUserContext: true
          }
        : {}
    );
    page = await context.newPage();

    page.on("request", (request) => {
      console.log("[request]", request.method, request.url);
    });

    page.on("response", (response) => {
      console.log("[response]", response.status, response.url);
    });

    page.on("console", (message) => {
      console.log("[console]", message.type(), message.text());
    });

    console.log("\n[file] goto start");
    await page.goto(fixture.url, { waitUntil: "load" });
    console.log("[file] goto ok");
    console.log("[file] current url:", await page.url());
    console.log("[file] title:", await page.title());
    console.log("[file] protocol:", await page.evaluate("() => location.protocol"));

    console.log("\n[http] goto start");
    try {
      const response = await page.goto(httpUrl, { waitUntil: "load" });
      console.log("[http] goto ok");
      console.log("[http] current url:", await page.url());
      console.log("[http] response status:", response?.status());
      console.log("[http] response text:", await response?.text());
    } catch (error) {
      console.error("[http] goto failed");
      console.error(error);
      console.log("[http] current url after failure:", await page.url());
    }
  } finally {
    await closeQuietly(page, "page");
    await closeQuietly(context, "context");
    await closeQuietly(browser, "browser");
    await closeQuietly(fixture, "fixture");
    await probeServer.close();
  }
}

run().catch((error) => {
  console.error("Probe failed.");
  console.error(error);
  process.exitCode = 1;
});
