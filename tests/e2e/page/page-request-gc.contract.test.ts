import { describe, expect, it } from "vitest";
import { withPage } from "../../helpers/browser.js";

describe("page requestGC contract e2e", () => {
  it("works like Playwright", async () => {
    await withPage(async (page) => {
      await page.evaluate(() => {
        (globalThis as typeof globalThis & {
          objectToDestroy: { hello: string } | null;
          weakRef: WeakRef<{ hello: string }>;
        }).objectToDestroy = { hello: "world" };
        (globalThis as typeof globalThis & {
          objectToDestroy: { hello: string } | null;
          weakRef: WeakRef<{ hello: string }>;
        }).weakRef = new WeakRef(
          (globalThis as typeof globalThis & {
            objectToDestroy: { hello: string } | null;
            weakRef: WeakRef<{ hello: string }>;
          }).objectToDestroy!
        );
      });

      await page.requestGC();
      expect(
        await page.evaluate(() =>
          (globalThis as typeof globalThis & {
            weakRef: WeakRef<{ hello: string }>;
          }).weakRef.deref()
        )
      ).toEqual({ hello: "world" });

      await page.requestGC();
      expect(
        await page.evaluate(() =>
          (globalThis as typeof globalThis & {
            weakRef: WeakRef<{ hello: string }>;
          }).weakRef.deref()
        )
      ).toEqual({ hello: "world" });

      await page.evaluate(() => {
        (globalThis as typeof globalThis & {
          objectToDestroy: { hello: string } | null;
        }).objectToDestroy = null;
      });
      await page.requestGC();
      expect(
        await page.evaluate(() =>
          (globalThis as typeof globalThis & {
            weakRef: WeakRef<{ hello: string }>;
          }).weakRef.deref()
        )
      ).toBe(undefined);
    });
  });
});
