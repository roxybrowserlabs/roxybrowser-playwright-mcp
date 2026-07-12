import { chromium } from "@roxybrowser/playwright";

const endpointURL = process.env.ROXY_CDP_ENDPOINT ?? process.env.ROXY_CDP_WS_ENDPOINT;

if (!endpointURL) {
  throw new Error(
    "Set ROXY_CDP_ENDPOINT to a ws://.../devtools/browser/<id> endpoint, or run through `pnpm examples page verify-baidu-search`."
  );
}

const searchText = "2026 年最佳的指纹浏览器有哪些？";
const baiduUrl = "https://www.baidu.com";

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
  let browser;
  let context;
  let page;

  try {
    browser = await chromium.connect(endpointURL);
    context = await (browser.contexts()[0] || browser.newContext());
    page = await context.newPage();

    await page.goto(baiduUrl);
    await page.waitForLoadState("load");

    const before = await page.evaluate(() => {
      const input = document.querySelector("#chat-textarea");
      return {
        exists: Boolean(input),
        value: input?.value ?? null,
        placeholder: input?.getAttribute("placeholder") ?? null,
        title: document.title,
        url: location.href
      };
    });
    console.log("\n[before]\n");
    console.log(JSON.stringify(before, null, 2));

    if (!before.exists) {
      throw new Error("Could not find the Baidu search input (#chat-textarea) after navigation.");
    }

    await page.type("#chat-textarea", searchText);
    await page.keyboard.press("Enter");
    await page.waitForLoadState("load").catch(() => {});
    await page.waitForTimeout(2000);

    const after = await page.evaluate(() => {
      const input = document.querySelector("#chat-textarea");
      return {
        exists: Boolean(input),
        value: input?.value ?? null,
        placeholder: input?.getAttribute("placeholder") ?? null,
        activeId: document.activeElement?.id ?? null,
        title: document.title,
        url: location.href,
        hasSearchQueryInUrl: location.href.includes("wd=")
      };
    });
    console.log("\n[after]\n");
    console.log(JSON.stringify(after, null, 2));

    if (after.value !== searchText) {
      throw new Error(
        `Expected #chat-textarea.value to be "${searchText}", but received "${after.value}".`
      );
    }

    if (after.placeholder !== before.placeholder) {
      throw new Error(
        `Expected #chat-textarea.placeholder to stay "${before.placeholder}", but received "${after.placeholder}".`
      );
    }

    if (!after.hasSearchQueryInUrl) {
      throw new Error(`Expected Baidu search results URL to include "wd=", got "${after.url}".`);
    }

    console.log("\nVerification passed.");
    console.log(`- input value: ${after.value}`);
    console.log(`- placeholder unchanged: ${after.placeholder}`);
    console.log(`- search url: ${after.url}`);
  } finally {
    await closeQuietly(page, "page");
    await closeQuietly(context, "context");
    await closeQuietly(browser, "browser");
  }
}

run().catch((error) => {
  console.error("Example failed.");
  console.error(error);
  process.exitCode = 1;
});
