import { firefox } from "@roxybrowser/playwright";
import { createExampleFixture } from "./helpers/fixture.mjs";

// This example demonstrates connecting to Firefox using the BiDi (WebDriver BiDi) protocol.
// BiDi is the modern standard for browser automation, offering better cross-browser compatibility.
//
// Usage:
// 1. Launch Firefox with remote debugging enabled:
//    /Applications/Firefox.app/Contents/MacOS/firefox --remote-debugging-port=9222
//
// 2. Set the WebSocket endpoint:
//    export ROXY_BIDI_ENDPOINT=ws://127.0.0.1:9222/session
//
// 3. Run this example:
//    node examples/page/connect-firefox-bidi.mjs

const wsEndpoint = process.env.ROXY_BIDI_ENDPOINT ?? process.env.ROXY_BIDI_WS_ENDPOINT;

if (!wsEndpoint) {
  throw new Error(
    "Set ROXY_BIDI_ENDPOINT to a ws://... BiDi endpoint, or run through `pnpm examples page connect-firefox-bidi`."
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
    console.log(`Connecting to Firefox via BiDi at ${wsEndpoint}...`);

    // Connect to Firefox using BiDi protocol
    browser = await firefox.connect(wsEndpoint);

    console.log("Connected! Browser version:", await browser.version());

    // Create a new browser context
    context = await browser.newContext({
      viewport: {
        width: 1280,
        height: 720
      }
    });

    // Create a new page
    page = await context.newPage();

    // Navigate to the test page
    console.log(`Navigating to ${fixture.url}...`);
    await page.goto(fixture.url);

    // Interact with the page
    console.log("Filling form...");
    await page.fill("#name", "BiDi User");
    await page.getByRole("button", { name: "Send" }).click();

    // Read results
    console.log("Page title:", await page.title());
    console.log("Status text:", await page.locator("#status").textContent());

    // Take a screenshot
    const screenshot = await page.screenshot();
    console.log(`Screenshot captured: ${screenshot.length} bytes`);

    console.log("\n✓ Example completed successfully!");
  } catch (error) {
    console.error("\n✗ Example failed:");
    console.error(error);
    throw error;
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
