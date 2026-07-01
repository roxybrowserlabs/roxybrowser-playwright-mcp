import { chromium, firefox } from "@roxybrowser/playwright";
import { createExampleFixture } from "./helpers/fixture.mjs";

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

async function run() {
  const fixture = await createExampleFixture();
  let browser;
  let context;
  let page;

  try {
    browser = await browserType.launch({
      headless: false,
      // headless: process.env.ROXY_HEADLESS === "false" ? false : true,
      ...(process.env.ROXY_BROWSER_CHANNEL ? { channel: process.env.ROXY_BROWSER_CHANNEL } : {}),
      ...(process.env.ROXY_EXECUTABLE_PATH
        ? { executablePath: process.env.ROXY_EXECUTABLE_PATH }
        : {}),
      human: {
        hoverBeforeClickMs: 0,
        clickHoldMs: 0,
        typingDelayMs: 0,
        typingVarianceMs: 0
      }
    });

    context = await browser.newContext({
      viewport: {
        width: 1280,
        height: 720
      }
    });

    page = await context.newPage();

    await page.goto(fixture.url);
    await page.fill("#name", "Roxy");
    await page.getByRole("button", { name: "Send" }).click();

    console.log("Browser version:", await browser.version());
    console.log("Page title:", await page.title());
    console.log("Status text:", await page.locator("#status").textContent());
  } catch (error) {
    console.error("Example failed.");
    console.error(error);
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
