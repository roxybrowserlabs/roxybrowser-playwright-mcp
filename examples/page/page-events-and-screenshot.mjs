import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, firefox } from "@roxybrowser/playwright";

const browserType = process.env.ROXY_BROWSER_NAME === "firefox" ? firefox : chromium;

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

async function createEventFixture() {
  const directory = await mkdtemp(join(tmpdir(), "roxybrowser-events-example-"));
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");

    if (url.pathname === "/api/message") {
      response.writeHead(200, {
        "content-type": "application/json"
      });
      response.end(JSON.stringify({ message: "hello from roxy" }));
      return;
    }

    if (url.pathname === "/api/submit") {
      response.writeHead(200, {
        "content-type": "application/json"
      });
      response.end(JSON.stringify({ ok: true, name: url.searchParams.get("name") ?? "" }));
      return;
    }

    if (url.pathname === "/api/ping") {
      response.writeHead(204);
      response.end();
      return;
    }

    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8"
    });
    response.end(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Roxy Events Example</title>
  </head>
  <body>
    <main>
      <label for="name">Name</label>
      <input id="name" aria-label="Name" />
      <button id="submit" type="button">Send</button>
      <div id="status">idle</div>
    </main>
    <script>
      const input = document.getElementById("name");
      const submit = document.getElementById("submit");
      const status = document.getElementById("status");

      window.addEventListener("load", async () => {
        const response = await fetch("/api/message");
        const payload = await response.json();
        status.textContent = payload.message;
      });

      submit.addEventListener("click", async () => {
        const response = await fetch("/api/submit?name=" + encodeURIComponent(input.value));
        const payload = await response.json();
        status.textContent = "submitted:" + payload.name;
      });
    </script>
  </body>
</html>`);
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to start event fixture server.");
  }

  return {
    screenshotPath: join(process.cwd(), "roxy-page-events-example.png"),
    url: `http://127.0.0.1:${address.port}/`,
    close: async () => {
      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
      await rm(directory, {
        force: true,
        recursive: true
      });
    }
  };
}

async function run() {
  const fixture = await createEventFixture();
  let browser;
  let context;
  let page;

  try {
    browser = await browserType.launch({
      headless: true,
      ...(process.env.ROXY_BROWSER_CHANNEL ? { channel: process.env.ROXY_BROWSER_CHANNEL } : {}),
      ...(process.env.ROXY_EXECUTABLE_PATH
        ? { executablePath: process.env.ROXY_EXECUTABLE_PATH }
        : {})
    });

    context = await browser.newContext({
      viewport: {
        width: 1280,
        height: 720
      }
    });
    page = await context.newPage();

    const logRequest = (request) => {
      console.log("[request]", request.method, request.url);
    };

    page.on("request", logRequest);
    page.on("response", (response) => {
      console.log("[response]", response.status, response.url);
    });
    page.on("requestfailed", (request) => {
      console.log("[requestfailed]", request.method, request.url, request.errorText);
    });
    page.once("load", () => {
      console.log("Page loaded!");
    });

    await page.goto(fixture.url, { waitUntil: "load" });
    await page.fill("#name", "Roxy");
    await page.getByRole("button", { name: "Send" }).click();

    page.removeListener("request", logRequest);
    await page.evaluate("() => fetch('/api/ping', { method: 'POST' })");

    const screenshot = await page.screenshot({
      fullPage: true,
      path: fixture.screenshotPath
    });

    console.log("Browser version:", await browser.version());
    console.log("Page title:", await page.title());
    console.log("Status text:", await page.locator("#status").textContent());
    console.log("Screenshot bytes:", screenshot.length);
    console.log("Screenshot path:", fixture.screenshotPath);
  } catch (error) {
    console.error("Example failed.");
    console.error(error);
    process.exitCode = 1;
  } finally {
    await closeQuietly(page, "page");
    await closeQuietly(context, "context");
    await closeQuietly(browser, "browser");
    await closeQuietly(fixture, "fixture");
  }
}

run().catch((error) => {
  console.error("Example failed.");
  console.error(error);
  process.exitCode = 1;
});
