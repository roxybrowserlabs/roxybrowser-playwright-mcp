import { describe, expect, it } from "vitest";
import { withPage } from "../../helpers/browser.js";

describe("page filechooser debug e2e", () => {
  it("installs runtime in iframe contexts", async () => {
    await withPage(async (page) => {
      await page.setContent(`
        <iframe
          id="picker-frame"
          srcdoc='<!doctype html><html><body><input id="upload" type="file"></body></html>'>
        </iframe>
      `);

      await page.waitForEvent("filechooser", { timeout: 1 }).catch(() => null);
      await expect.poll(() => page.frames().length).toBeGreaterThan(1);
      const frame = page.frames().find((candidate) => candidate !== page.mainFrame());
      expect(frame).toBeTruthy();

      const installed = await frame!.evaluate(() => {
        return Boolean((globalThis as typeof globalThis & {
          __roxyFileChooserRuntimeInstalled?: boolean;
        }).__roxyFileChooserRuntimeInstalled);
      });

      const mainInstalled = await page.evaluate(() => {
        return Boolean((globalThis as typeof globalThis & {
          __roxyFileChooserRuntimeInstalled?: boolean;
        }).__roxyFileChooserRuntimeInstalled);
      });

      expect(mainInstalled).toBe(true);
      expect(installed).toBe(true);
    });
  });

  it("sets files and fires input/change events", async () => {
    await withPage(async (page) => {
      await page.setContent(`
        <input type="file" id="upload">
        <script>
          window.__events = [];
          const input = document.getElementById("upload");
          input.addEventListener("input", () => window.__events.push("input"));
          input.addEventListener("change", () => window.__events.push("change"));
        </script>
      `);

      await page.setInputFiles("input", {
        name: "file.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("hello", "utf8")
      });

      expect(await page.$eval("input", (input) => (input as HTMLInputElement).files?.length ?? 0)).toBe(1);
      expect(await page.evaluate<string[]>("() => window.__events")).toEqual(["input", "change"]);
    });
  });

  it("sets files through waitForEvent chaining like Playwright", async () => {
    await withPage(async (page) => {
      await page.setContent(`
        <input type="file" id="upload">
        <script>
          window.__events = [];
          const input = document.getElementById("upload");
          input.addEventListener("input", () => window.__events.push("input"));
          input.addEventListener("change", () => window.__events.push("change"));
        </script>
      `);

      const result = await Promise.all([
        page.waitForEvent("filechooser").then((chooser) =>
          chooser.setFiles({
            name: "file.txt",
            mimeType: "text/plain",
            buffer: Buffer.from("hello", "utf8")
          })
        ),
        page.$eval("input", async (input) => {
          const picker = input as HTMLInputElement;
          picker.click();
          await new Promise((resolve) => {
            picker.oninput = () => resolve(undefined);
          });
          return {
            events: (globalThis as typeof globalThis & { __events?: string[] }).__events ?? [],
            length: picker.files?.length ?? 0,
            name: picker.files?.[0]?.name ?? null
          };
        })
      ]);

      const pageResult = result[1];
      expect(pageResult.length).toBe(1);
      expect(pageResult.name).toBe("file.txt");
      expect(pageResult.events).toEqual(["input", "change"]);
    });
  });

  it("emits filechooser for iframe clicks", async () => {
    await withPage(async (page) => {
      await page.setContent(`
        <iframe
          id="picker-frame"
          srcdoc='<!doctype html><html><body><input id="upload" type="file"></body></html>'>
        </iframe>
      `);

      await page.waitForEvent("filechooser", { timeout: 1 }).catch(() => null);
      await expect.poll(() => page.frames().length).toBeGreaterThan(1);
      const frame = page.frames().find((candidate) => candidate !== page.mainFrame());
      expect(frame).toBeTruthy();

      const chooserPromise = page.waitForEvent("filechooser", { timeout: 3_000 });
      await frame!.click("#upload");
      await expect(chooserPromise).resolves.toBeTruthy();
    });
  });


  it("clicks ordinary iframe controls", async () => {
    await withPage(async (page) => {
      await page.setContent(`
        <iframe
          id="click-frame"
          srcdoc='<!doctype html><html><body><button id="inside">Inside</button><script>window.__clicked = 0; document.getElementById("inside").addEventListener("click", () => window.__clicked += 1);</script></body></html>'>
        </iframe>
      `);

      await expect.poll(() => page.frames().length).toBeGreaterThan(1);
      const frame = page.frames().find((candidate) => candidate !== page.mainFrame());
      expect(frame).toBeTruthy();
      await expect
        .poll(() => frame!.evaluate(() => document.getElementById("inside")?.textContent ?? null))
        .toBe("Inside");

      const handle = await frame!.$("#inside");
      expect(handle).toBeTruthy();
      expect(await frame!.$eval("#inside", (element) => element.textContent)).toBe("Inside");

      await frame!.click("#inside", { timeout: 2_000 });
      expect(await frame!.evaluate(() => (globalThis as typeof globalThis & { __clicked?: number }).__clicked ?? 0)).toBe(1);
    });
  });
});
