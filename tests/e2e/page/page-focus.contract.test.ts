import { describe, expect, it } from "vitest";
import { withPage } from "../../helpers/browser.js";

describe("page focus contract e2e", () => {
  it("focuses a focusable element", async () => {
    await withPage(async (page) => {
      await page.setContent("<div id=d1 tabIndex=0></div>");

      expect(await page.evaluate(() => document.activeElement?.nodeName)).toBe("BODY");
      await page.focus("#d1");

      expect(await page.evaluate(() => document.activeElement?.id)).toBe("d1");
    });
  });

  it("emits focus events", async () => {
    await withPage(async (page) => {
      await page.setContent("<div id=d1 tabIndex=0></div>");
      await page.evaluate(() => {
        (window as unknown as { focused: boolean }).focused = false;
        document.querySelector("#d1")!.addEventListener("focus", () => {
          (window as unknown as { focused: boolean }).focused = true;
        });
      });

      await page.focus("#d1");

      expect(await page.evaluate(() => (window as unknown as { focused: boolean }).focused)).toBe(true);
    });
  });

  it("emits blur events when focus moves", async () => {
    await withPage(async (page) => {
      await page.setContent(`
        <div id="d1" tabIndex="0">DIV1</div>
        <div id="d2" tabIndex="0">DIV2</div>
      `);
      await page.evaluate(() => {
        (window as unknown as { events: string[] }).events = [];
        document.querySelector("#d1")!.addEventListener("blur", () => {
          (window as unknown as { events: string[] }).events.push("blur");
        });
        document.querySelector("#d2")!.addEventListener("focus", () => {
          (window as unknown as { events: string[] }).events.push("focus");
        });
      });

      await page.focus("#d1");
      await page.focus("#d2");

      expect(await page.evaluate(() => (window as unknown as { events: string[] }).events)).toEqual(["blur", "focus"]);
    });
  });

  it("traverses focus with Tab while typing", async () => {
    await withPage(async (page) => {
      await page.setContent('<input id="i1"><input id="i2">');
      await page.evaluate(() => {
        (window as unknown as { focused: boolean }).focused = false;
        document.querySelector("#i2")!.addEventListener("focus", () => {
          (window as unknown as { focused: boolean }).focused = true;
        });
      });

      await page.focus("#i1");
      await page.keyboard.type("First");
      await page.keyboard.press("Tab");
      await page.keyboard.type("Last");

      expect(await page.evaluate(() => (window as unknown as { focused: boolean }).focused)).toBe(true);
      expect(await page.$eval("#i1", (element) => (element as HTMLInputElement).value)).toBe("First");
      expect(await page.$eval("#i2", (element) => (element as HTMLInputElement).value)).toBe("Last");
    });
  });

  it("traverses focus in both directions", async () => {
    await withPage(async (page) => {
      await page.setContent('<input value="1"><input value="2"><input value="3">');

      await page.keyboard.press("Tab");
      expect(await page.evaluate(() => (document.activeElement as HTMLInputElement).value)).toBe("1");
      await page.keyboard.press("Tab");
      expect(await page.evaluate(() => (document.activeElement as HTMLInputElement).value)).toBe("2");
      await page.keyboard.press("Tab");
      expect(await page.evaluate(() => (document.activeElement as HTMLInputElement).value)).toBe("3");
      await page.keyboard.press("Shift+Tab");
      expect(await page.evaluate(() => (document.activeElement as HTMLInputElement).value)).toBe("2");
      await page.keyboard.press("Shift+Tab");
      expect(await page.evaluate(() => (document.activeElement as HTMLInputElement).value)).toBe("1");
    });
  });

  it("keeps focus when attempting to focus a non-focusable element", async () => {
    await withPage(async (page) => {
      await page.setContent(`
        <div id="focusable" tabindex="0">focusable</div>
        <div id="non-focusable">not focusable</div>
        <script>
          window.eventLog = [];
          focusable.addEventListener('blur', () => window.eventLog.push('blur focusable'));
          focusable.addEventListener('focus', () => window.eventLog.push('focus focusable'));
          nonFocusable.addEventListener('blur', () => window.eventLog.push('blur non-focusable'));
          nonFocusable.addEventListener('focus', () => window.eventLog.push('focus non-focusable'));
        </script>
      `);

      await page.locator("#focusable").click();
      expect(await page.evaluate(() => document.activeElement?.id)).toBe("focusable");
      await page.locator("#non-focusable").focus();

      expect(await page.evaluate(() => document.activeElement?.id)).toBe("focusable");
      expect(await page.evaluate(() => (window as unknown as { eventLog: string[] }).eventLog)).toEqual([
        "focus focusable"
      ]);
    });
  });
});
