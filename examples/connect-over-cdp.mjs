import { chromium } from "@roxybrowser/playwright";
import { createExampleFixture } from "./helpers/fixture.mjs";

const endpointURL = process.env.ROXY_CDP_WS_ENDPOINT;

if (!endpointURL) {
  throw new Error(
    "Set ROXY_CDP_WS_ENDPOINT to a ws://.../devtools/browser/<id> endpoint before running this example."
  );
}

const fixture = await createExampleFixture();

try {
  const browser = await chromium.connectOverCDP(endpointURL);

  try {
    const context = await browser.newContext();

    try {
      const page = await context.newPage();

      try {
        await page.goto(fixture.url);
        await page.fill("#name", "CDP");
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
