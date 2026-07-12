import { chromium, firefox } from "@roxybrowser/playwright";
import { createExampleFixture } from "./helpers/fixture.mjs";

const isFirefox = process.env.ROXY_BROWSER_NAME === "firefox";
const browserType = isFirefox ? firefox : chromium;
const endpointURL = isFirefox
  ? process.env.ROXY_BIDI_ENDPOINT ?? process.env.ROXY_BIDI_WS_ENDPOINT
  : process.env.ROXY_CDP_ENDPOINT ?? process.env.ROXY_CDP_WS_ENDPOINT;

if (!endpointURL) {
  throw new Error(
    isFirefox
      ? "Set ROXY_BIDI_ENDPOINT to a ws://... BiDi endpoint."
      : "Set ROXY_CDP_ENDPOINT to a ws://.../devtools/browser/<id> endpoint."
  );
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
  let browser;
  let context;
  let page;

  try {
    browser = await browserType.connect(endpointURL);

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
