import { chromium } from "../../src/index.js";
import type { Browser, BrowserContext, Page } from "../../src/types/api.js";

export async function withPage<T>(
  run: (page: Page, context: BrowserContext, browser: Browser) => Promise<T>
): Promise<T> {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.ROXY_E2E_EXECUTABLE_PATH
      ? { executablePath: process.env.ROXY_E2E_EXECUTABLE_PATH }
      : {})
  });

  try {
    const context = await browser.newContext();

    try {
      const page = await context.newPage();

      try {
        return await run(page, context, browser);
      } finally {
        await page.close();
      }
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
  }
}
