import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withPage } from "../../helpers/browser.js";
import { createHistoryPageFixture } from "../../helpers/server.js";

describe("locator drop contract e2e", () => {
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

  it("drops data and files onto a locator", async () => {
    await withPage(async (page) => {
      await page.setContent(`
        <style>body { margin: 0; }</style>
        <div id="dropzone" style="width: 200px; height: 120px"></div>
        <script>
          window.dropResult = null;
          const dropzone = document.querySelector("#dropzone");
          dropzone.addEventListener("dragover", event => event.preventDefault());
          dropzone.addEventListener("drop", event => {
            event.preventDefault();
            window.dropResult = {
              text: event.dataTransfer.getData("text/plain"),
              files: [...event.dataTransfer.files].map(file => ({
                name: file.name,
                type: file.type
              })),
              x: event.clientX,
              y: event.clientY
            };
          });
        </script>
      `);

      await page.locator("#dropzone").drop({
        data: { "text/plain": "hello world" },
        files: { name: "note.txt", mimeType: "text/plain", buffer: Buffer.from("hello file") }
      }, { position: { x: 10, y: 20 } });

      await expect.poll(() => page.evaluate(() => window.dropResult)).toMatchObject({
        files: [{ name: "note.txt", type: "text/plain" }],
        text: "hello world",
        x: 10,
        y: 20
      });
    });
  });

  it("throws when the target rejects the drop", async () => {
    await withPage(async (page) => {
      await page.setContent('<div id="dropzone"></div>');

      await expect(page.locator("#dropzone").drop({
        data: { "text/plain": "hello" }
      })).rejects.toThrow("Drop target did not accept the drop");
    });
  });
});
