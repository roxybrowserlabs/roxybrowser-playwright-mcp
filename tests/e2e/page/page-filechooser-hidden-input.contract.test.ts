import { describe, expect, it } from "vitest";
import { withPage } from "../../helpers/browser.js";

describe("page hidden-input filechooser contract e2e", () => {
  it("emits filechooser when a visible button triggers a hidden file input", async () => {
    await withPage(async (page) => {
      await page.setContent(`
        <button id="trigger" type="button">Select video</button>
        <input id="upload" type="file" style="display:none">
        <div id="status">idle</div>
        <script>
          window.__events = [];
          const trigger = document.getElementById("trigger");
          const input = document.getElementById("upload");
          const status = document.getElementById("status");
          trigger.addEventListener("click", () => {
            status.textContent = "chooser-opened";
            input.click();
          });
          input.addEventListener("input", () => {
            window.__events.push("input");
            status.textContent = input.files && input.files[0] ? "input:" + input.files[0].name : "input:empty";
          });
          input.addEventListener("change", () => {
            window.__events.push("change");
            status.textContent = input.files && input.files[0] ? "uploaded:" + input.files[0].name : "uploaded:empty";
          });
        </script>
      `);

      const [, pageResult] = await Promise.all([
        page.waitForEvent("filechooser").then((chooser) =>
          chooser.setFiles({
            name: "file.txt",
            mimeType: "text/plain",
            buffer: Buffer.from("hello", "utf8")
          })
        ),
        page.$eval("#trigger", (button) => {
          (button as HTMLButtonElement).click();
        }).then(async () => {
          await expect.poll(() => page.locator("#status").textContent()).toBe("uploaded:file.txt");
          return page.evaluate(() => {
            const input = document.getElementById("upload");
            const state = (globalThis as typeof globalThis & {
              __events?: string[];
            }).__events ?? [];
            return {
              events: state,
              fileCount: (input as HTMLInputElement | null)?.files?.length ?? 0,
              fileName: (input as HTMLInputElement | null)?.files?.[0]?.name ?? null
            };
          });
        })
      ]);

      expect(pageResult.fileCount).toBe(1);
      expect(pageResult.fileName).toBe("file.txt");
      expect(pageResult.events).toEqual(["input", "change"]);
    });
  });

  it("can clear files when a visible button triggers a hidden file input", async () => {
    await withPage(async (page) => {
      await page.setContent(`
        <button id="trigger" type="button">Select video</button>
        <input id="upload" type="file" style="display:none">
        <div id="status">idle</div>
        <script>
          window.__events = [];
          const trigger = document.getElementById("trigger");
          const input = document.getElementById("upload");
          const status = document.getElementById("status");
          trigger.addEventListener("click", () => {
            input.click();
          });
          input.addEventListener("input", () => {
            window.__events.push("input");
            status.textContent = "input:" + (input.files ? input.files.length : 0);
          });
          input.addEventListener("change", () => {
            window.__events.push("change");
            status.textContent = "change:" + (input.files ? input.files.length : 0);
          });
        </script>
      `);

      await Promise.all([
        page.waitForEvent("filechooser").then((chooser) =>
          chooser.setFiles({
            name: "file.txt",
            mimeType: "text/plain",
            buffer: Buffer.from("hello", "utf8")
          })
        ),
        page.$eval("#trigger", (button) => {
          (button as HTMLButtonElement).click();
        })
      ]);
      await expect.poll(() => page.locator("#status").textContent()).toBe("change:1");

      await Promise.all([
        page.waitForEvent("filechooser").then((chooser) => chooser.setFiles([])),
        page.$eval("#trigger", (button) => {
          (button as HTMLButtonElement).click();
        })
      ]);
      await expect.poll(() => page.locator("#status").textContent()).toBe("change:0");

      const result = await page.evaluate(() => {
        const input = document.getElementById("upload") as HTMLInputElement | null;
        const state = (globalThis as typeof globalThis & {
          __events?: string[];
        }).__events ?? [];
        return {
          events: state,
          fileCount: input?.files?.length ?? 0
        };
      });

      expect(result.fileCount).toBe(0);
      expect(result.events).toEqual(["input", "change", "input", "change"]);
    });
  });
});
