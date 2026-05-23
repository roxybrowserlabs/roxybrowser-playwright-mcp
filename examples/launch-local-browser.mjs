import { chromium, firefox } from "@roxybrowser/playwright";
import { createExampleFixture } from "./helpers/fixture.mjs";

const fixture = await createExampleFixture();
const browserType = process.env.ROXY_BROWSER_NAME === "firefox" ? firefox : chromium;

try {
  const browser = await browserType.launch({
    headless: process.env.ROXY_HEADLESS === "false" ? false : true,
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

  try {
    const context = await browser.newContext({
      viewport: {
        width: 1280,
        height: 720
      }
    });

    try {
      const page = await context.newPage();

      try {
        await page.goto(fixture.url);
        await page.fill("#name", "Roxy");
        await page.getByRole("button", { name: "Send" }).click();

        console.log("Browser version:", await browser.version());
        console.log("Page title:", await page.title());
        console.log("Status text:", await page.locator("#status").textContent());
      } finally {
        await page.close();
      }
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
  }
} finally {
  await fixture.close();
}
