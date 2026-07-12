import { firefox } from "@roxybrowser/playwright";
import { createExampleFixture } from "./helpers/fixture.mjs";

// This example demonstrates connecting to Firefox with the BiDi (WebDriver BiDi) protocol.
//
// Usage:
//    export ROXY_BIDI_ENDPOINT=ws://127.0.0.1:9222/session
//    node examples/page/launch-firefox-bidi.mjs

const endpointURL = process.env.ROXY_BIDI_ENDPOINT ?? process.env.ROXY_BIDI_WS_ENDPOINT;

if (!endpointURL) {
  throw new Error(
    "Set ROXY_BIDI_ENDPOINT to a ws://... BiDi endpoint, or run through `pnpm examples page launch-firefox-bidi`."
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
    console.log("Connecting to Firefox with BiDi protocol...");

    browser = await firefox.connect(endpointURL);

    console.log("Firefox connected! Browser version:", await browser.version());

    // Create a new browser context with custom settings
    context = await browser.newContext({
      viewport: {
        width: 1280,
        height: 720
      },
      locale: "en-US",
      timezoneId: "America/New_York"
    });

    // Create a new page
    page = await context.newPage();

    // Set up event listeners
    page.on("console", (msg) => {
      console.log(`[Browser Console] ${msg.type()}: ${msg.text()}`);
    });

    page.on("request", (request) => {
      console.log(`[Request] ${request.method} ${request.url}`);
    });

    page.on("response", (response) => {
      console.log(`[Response] ${response.status} ${response.url}`);
    });

    // Navigate to the test page
    console.log(`\nNavigating to ${fixture.url}...`);
    const response = await page.goto(fixture.url);
    console.log(`Navigation response: ${response?.status} ${response?.statusText}`);

    // Wait for page to be fully loaded
    await page.waitForLoadState("load");
    console.log("Page loaded!");

    // Interact with the page using different selector strategies
    console.log("\nInteracting with the page...");

    // Fill input using CSS selector
    await page.fill("#name", "BiDi Firefox User");

    // Click button using role selector
    await page.getByRole("button", { name: "Send" }).click();

    // Read results using locator
    const statusText = await page.locator("#status").textContent();
    console.log("Status text:", statusText);

    // Get page title
    const title = await page.title();
    console.log("Page title:", title);

    // Evaluate JavaScript in the page
    const userAgent = await page.evaluate(() => navigator.userAgent);
    console.log("User agent:", userAgent);

    // Take a screenshot
    console.log("\nTaking screenshot...");
    const screenshot = await page.screenshot({ type: "png" });
    console.log(`Screenshot captured: ${screenshot.length} bytes`);

    // Get page content
    const content = await page.content();
    console.log(`Page HTML length: ${content.length} characters`);

    // Test navigation
    console.log("\nTesting navigation...");
    await page.goto("https://example.com");
    console.log("Navigated to:", await page.url());

    await page.goBack();
    console.log("Went back to:", await page.url());

    await page.goForward();
    console.log("Went forward to:", await page.url());

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
