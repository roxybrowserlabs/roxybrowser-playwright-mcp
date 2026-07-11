import { describe, expect, it } from "vitest";
import { withPage } from "../../helpers/browser.js";

describe("page screencast actions contract e2e", () => {
  it("shows click annotations with Playwright-style tags", async () => {
    await withPage(async (page) => {
      await page.setContent('<button style="margin: 40px">Click me</button>');
      await page.screencast.showActions({ duration: 250 });

      const clickPromise = page.click("button");
      await page.waitForFunction(() => {
        const highlight = document.querySelector("x-pw-highlight");
        const point = document.querySelector("x-pw-action-point");
        const title = document.querySelector("x-pw-title");
        return (
          highlight instanceof HTMLElement &&
          point instanceof HTMLElement &&
          title instanceof HTMLElement &&
          !highlight.hidden &&
          !point.hidden &&
          title.textContent === "click"
        );
      });

      expect(
        await page.evaluate(`() => ({
          highlight: !document.querySelector("x-pw-highlight")?.hidden,
          point: !document.querySelector("x-pw-action-point")?.hidden,
          title: document.querySelector("x-pw-title")?.textContent ?? null
        })`)
      ).toEqual({
        highlight: true,
        point: true,
        title: "click"
      });

      await clickPromise;
      await page.waitForFunction(() => {
        const point = document.querySelector("x-pw-action-point");
        const title = document.querySelector("x-pw-title");
        return (
          point instanceof HTMLElement &&
          title instanceof HTMLElement &&
          point.hidden &&
          title.hidden
        );
      });
    });
  });

  it("renders title positioning, font size and cursor mode", async () => {
    await withPage(async (page) => {
      await page.setContent('<button style="margin: 40px">Click me</button>');
      await page.screencast.showActions({
        duration: 120,
        position: "bottom-left",
        fontSize: 24,
        cursor: "none"
      });

      const clickPromise = page.click("button");
      await page.waitForFunction(`() => {
        const title = document.querySelector("x-pw-title");
        const cursor = document.querySelector("x-pw-action-cursor");
        return (
          title instanceof HTMLElement &&
          cursor instanceof HTMLElement &&
          title.style.bottom === "6px" &&
          title.style.left === "6px" &&
          title.style.fontSize === "24px" &&
          cursor.hidden
        );
      }`);

      expect(
        await page.evaluate(`() => {
          const title = document.querySelector("x-pw-title");
          const cursor = document.querySelector("x-pw-action-cursor");
          if (!(title instanceof HTMLElement) || !(cursor instanceof HTMLElement))
            return null;
          return {
            bottom: title.style.bottom,
            left: title.style.left,
            fontSize: title.style.fontSize,
            cursorHidden: cursor.hidden
          };
        }`)
      ).toEqual({
        bottom: "6px",
        left: "6px",
        fontSize: "24px",
        cursorHidden: true
      });

      await clickPromise;
    });
  });

  it("annotates fill and stops after hideActions", async () => {
    await withPage(async (page) => {
      await page.setContent('<textarea style="margin: 40px"></textarea>');
      await page.screencast.showActions({ duration: 80 });

      const fillPromise = page.fill("textarea", "hello");
      await page.waitForFunction(
        `() => document.querySelector("x-pw-title")?.textContent === "fill"`
      );
      await fillPromise;

      await page.screencast.hideActions();
      await page.setContent('<button style="margin: 40px">Click me</button>');
      await page.click("button");

      expect(
        await page.evaluate(`() => ({
          titleHidden: document.querySelector("x-pw-title")?.hidden ?? null,
          pointHidden: document.querySelector("x-pw-action-point")?.hidden ?? null
        })`)
      ).toEqual({
        titleHidden: true,
        pointHidden: true
      });
    });
  });

  it("moves the action cursor between clicks and survives navigation", async () => {
    await withPage(async (page) => {
      await page.setContent(
        '<button id="a" style="position:fixed;top:20px;left:20px">A</button><button id="b" style="position:fixed;bottom:20px;right:20px">B</button>'
      );
      await page.screencast.showActions({ duration: 120 });

      const firstClick = page.click("#a", { force: true });
      await page.waitForFunction(() => {
        const cursor = document.querySelector("x-pw-action-cursor");
        return (
          cursor instanceof HTMLElement &&
          !cursor.hidden &&
          Boolean(cursor.style.top) &&
          Boolean(cursor.style.left)
        );
      });
      const firstPosition = await page.evaluate(`() => {
        const cursor = document.querySelector("x-pw-action-cursor");
        return cursor instanceof HTMLElement ? { top: cursor.style.top, left: cursor.style.left } : null;
      }`);
      await firstClick;

      await page.setContent('<button id="nav" style="margin:40px">After Nav</button>');
      const secondClick = page.click("#nav");
      await page.waitForFunction(() => {
        const cursor = document.querySelector("x-pw-action-cursor");
        const title = document.querySelector("x-pw-title");
        return (
          cursor instanceof HTMLElement &&
          title instanceof HTMLElement &&
          !cursor.hidden &&
          title.textContent === "click" &&
          Boolean(cursor.style.top) &&
          Boolean(cursor.style.left)
        );
      });
      const secondPosition = await page.evaluate(`() => {
        const cursor = document.querySelector("x-pw-action-cursor");
        const title = document.querySelector("x-pw-title");
        return cursor instanceof HTMLElement && title instanceof HTMLElement
          ? {
              top: cursor.style.top,
              left: cursor.style.left,
              title: title.textContent ?? null
            }
          : null;
      }`);
      await secondClick;

      expect(firstPosition).not.toEqual(secondPosition && { top: secondPosition.top, left: secondPosition.left });
      expect(secondPosition).toEqual(
        expect.objectContaining({
          title: "click"
        })
      );
    });
  });
});
