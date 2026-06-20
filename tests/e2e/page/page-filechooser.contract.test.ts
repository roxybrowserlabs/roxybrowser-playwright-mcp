import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TimeoutError } from "../../../src/errors.js";
import { withPage } from "../../helpers/browser.js";
import { createHistoryPageFixture } from "../../helpers/server.js";

describe("page filechooser contract e2e", () => {
  let fixture: Awaited<ReturnType<typeof createHistoryPageFixture>>;

  beforeAll(async () => {
    fixture = await createHistoryPageFixture();
  });

  beforeEach(() => {
    fixture.server.reset();
  });

  afterAll(async () => {
    await fixture.close();
  });

  it("emits filechooser via waitForEvent and exposes page, element and single-file state", async () => {
    await withPage(async (page) => {
      await page.setContent(`<input type="file">`);

      const [chooser] = await Promise.all([
        page.waitForEvent("filechooser"),
        page.click("input")
      ]);

      expect(chooser.page()).toBe(page);
      expect(chooser.element()).toBeTruthy();
      expect(chooser.isMultiple()).toBe(false);
    });
  });

  it("supports once, prependListener, on/off and addListener/removeListener semantics", async () => {
    await withPage(async (page) => {
      await page.setContent(`<input type="file">`);

      const onceChooserPromise = new Promise((resolve) => page.once("filechooser", resolve));
      await page.click("input");
      expect(await onceChooserPromise).toBeTruthy();

      const prependChooserPromise = new Promise((resolve) => page.prependListener("filechooser", resolve));
      await page.click("input");
      expect(await prependChooserPromise).toBeTruthy();

      const onOffChooserPromise = new Promise((resolve) => {
        const listener = (chooser: unknown) => {
          page.off("filechooser", listener);
          resolve(chooser);
        };
        page.on("filechooser", listener);
      });
      await page.click("input");
      expect(await onOffChooserPromise).toBeTruthy();

      const addRemoveChooserPromise = new Promise((resolve) => {
        const listener = (chooser: unknown) => {
          page.removeListener("filechooser", listener);
          resolve(chooser);
        };
        page.addListener("filechooser", listener);
      });
      await page.click("input");
      expect(await addRemoveChooserPromise).toBeTruthy();
    });
  });

  it("supports timeout 0 and returns the same chooser to concurrent waiters", async () => {
    await withPage(async (page) => {
      await page.setContent(`<input type="file">`);

      const chooser = await Promise.all([
        page.waitForEvent("filechooser", { timeout: 0 }),
        page.waitForEvent("filechooser"),
        page.$eval("input", (input) => {
          (input as HTMLInputElement).click();
        })
      ]).then(([first, second]) => {
        expect(first).toBe(second);
        return first;
      });

      expect(chooser).toBeTruthy();
    });
  });

  it("handles filechooser events coming from iframes", async () => {
    await withPage(async (page) => {
      await page.setContent(`
        <iframe
          id="picker-frame"
          srcdoc='<!doctype html><html><body><input id="upload" type="file"></body></html>'>
        </iframe>
      `);

      await expect.poll(() => page.frames().length).toBeGreaterThan(1);
      const frame = page.frames().find((candidate) => candidate !== page.mainFrame());
      expect(frame).toBeTruthy();

      const [chooser] = await Promise.all([
        page.waitForEvent("filechooser"),
        frame!.click("#upload")
      ]);

      expect(chooser.page()).toBe(page);
      expect(chooser.element()).toBeTruthy();
    });
  });

  it("respects the default timeout like Playwright", async () => {
    await withPage(async (page) => {
      page.setDefaultTimeout(1);

      const error = await page.waitForEvent("filechooser").catch((caught: Error) => caught);

      expect(error).toBeInstanceOf(TimeoutError);
    });
  });

  it("prioritizes an explicit timeout over the default timeout like Playwright", async () => {
    await withPage(async (page) => {
      page.setDefaultTimeout(0);

      const error = await page.waitForEvent("filechooser", { timeout: 1 }).catch((caught: Error) => caught);

      expect(error).toBeInstanceOf(TimeoutError);
    });
  });

  it("works when the file input is not attached to the DOM", async () => {
    await withPage(async (page) => {
      const [, content] = await Promise.all([
        page.waitForEvent("filechooser").then((chooser) => chooser.setFiles({
          name: "file-to-upload.txt",
          mimeType: "text/plain",
          buffer: Buffer.from("contents of the file", "utf8")
        })),
        page.evaluate(async () => {
          const input = document.createElement("input");
          input.type = "file";
          input.click();
          await new Promise((resolve) => {
            input.oninput = () => resolve(undefined);
          });
          const reader = new FileReader();
          const loaded = new Promise((resolve) => {
            reader.onload = () => resolve(reader.result);
          });
          reader.readAsText(input.files![0]!);
          return loaded;
        })
      ]);

      expect(content).toBe("contents of the file");
    });
  });

  it("sets files through the chooser and can reset them with an empty list", async () => {
    await withPage(async (page) => {
      await page.setContent(`<input type="file">`);

      const firstLengthPromise = Promise.all([
        page.waitForEvent("filechooser").then((chooser) => chooser.setFiles({
          name: "file-to-upload.txt",
          mimeType: "text/plain",
          buffer: Buffer.from("contents of the file", "utf8")
        })),
        page.$eval("input", async (input) => {
          const picker = input as HTMLInputElement;
          picker.click();
          await new Promise((resolve) => {
            picker.oninput = () => resolve(undefined);
          });
          return picker.files?.length ?? 0;
        })
      ]);

      const [, firstLength] = await firstLengthPromise;
      expect(firstLength).toBe(1);
      expect(await page.$eval("input", (input) => (input as HTMLInputElement).files?.[0]?.name ?? null)).toBe("file-to-upload.txt");

      const secondLengthPromise = Promise.all([
        page.waitForEvent("filechooser").then((chooser) => chooser.setFiles([])),
        page.$eval("input", async (input) => {
          const picker = input as HTMLInputElement;
          picker.click();
          await new Promise((resolve) => {
            picker.oninput = () => resolve(undefined);
          });
          return picker.files?.length ?? 0;
        })
      ]);

      const [, secondLength] = await secondLengthPromise;
      expect(secondLength).toBe(0);
    });
  });

  it("detects multiple file pickers like Playwright", async () => {
    await withPage(async (page) => {
      await page.setContent(`<input multiple type="file">`);

      const [chooser] = await Promise.all([
        page.waitForEvent("filechooser"),
        page.click("input")
      ]);

      expect(chooser.isMultiple()).toBe(true);
    });
  });

  it("treats webkitdirectory pickers as multiple like Playwright", async () => {
    await withPage(async (page) => {
      await page.setContent(`<input multiple webkitdirectory type="file">`);

      const [chooser] = await Promise.all([
        page.waitForEvent("filechooser"),
        page.click("input")
      ]);

      expect(chooser.isMultiple()).toBe(true);
    });
  });

  it("emits filechooser after navigations like Playwright", async () => {
    await withPage(async (page) => {
      const logs: string[] = [];
      page.on("filechooser", () => {
        logs.push("filechooser");
      });

      await page.goto(fixture.server.PREFIX + "/empty.html");
      await page.setContent(`<input type="file">`);
      await Promise.all([
        page.waitForEvent("filechooser"),
        page.click("input")
      ]);

      await page.goto(fixture.server.CROSS_PROCESS_PREFIX + "/empty.html");
      await page.setContent(`<input type="file">`);
      await Promise.all([
        page.waitForEvent("filechooser"),
        page.click("input")
      ]);

      expect(logs).toEqual(["filechooser", "filechooser"]);
    });
  });

  it("honors filechooser listeners attached before navigation like Playwright", async () => {
    await withPage(async (page) => {
      const chooserPromise = new Promise((resolve) => {
        page.once("filechooser", resolve);
      });

      await page.goto(fixture.server.PREFIX + "/empty.html");
      await page.goto(fixture.server.CROSS_PROCESS_PREFIX + "/empty.html");
      await page.setContent(`<input type="file">`);

      const [chooser] = await Promise.all([
        chooserPromise,
        page.click("input")
      ]);

      expect(chooser).toBeTruthy();
    });
  });
});
