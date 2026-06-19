import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withPage } from "../../helpers/browser.js";
import { createHistoryPageFixture } from "../../helpers/server.js";

describe("locator drop contract e2e", () => {
  let fixture: Awaited<ReturnType<typeof createHistoryPageFixture>>;
  let tempDir: string;

  beforeAll(async () => {
    fixture = await createHistoryPageFixture();
    tempDir = await mkdtemp(join(tmpdir(), "roxy-drop-"));
  });

  beforeEach(() => {
    fixture.server.reset();
  });

  afterAll(async () => {
    await fixture.close();
    await rm(tempDir, { force: true, recursive: true });
  });

  async function setupDropzone(page: Parameters<Parameters<typeof withPage>[0]>[0]) {
    await page.setContent(`
      <style>#dropzone { width: 300px; height: 200px; border: 2px dashed #888; }</style>
      <div id="dropzone"></div>
      <script>
        window.__dropInfo = null;
        const zone = document.getElementById("dropzone");
        zone.addEventListener("dragenter", event => event.preventDefault());
        zone.addEventListener("dragover", event => event.preventDefault());
        zone.addEventListener("drop", async event => {
          event.preventDefault();
          const files = [];
          for (const file of event.dataTransfer.files) {
            files.push({ name: file.name, type: file.type, size: file.size, text: await file.text() });
          }
          const data = {};
          for (const type of event.dataTransfer.types) {
            if (type !== "Files")
              data[type] = event.dataTransfer.getData(type);
          }
          window.__dropInfo = { files, data };
        });
      </script>
    `);
  }

  async function getDropInfo(page: Parameters<Parameters<typeof withPage>[0]>[0]) {
    return await page.waitForFunction(() => (window as unknown as { __dropInfo: unknown }).__dropInfo)
      .then((handle) => handle.jsonValue());
  }

  it("drops a file payload", async () => {
    await withPage(async (page) => {
      await setupDropzone(page);
      await page.locator("#dropzone").drop({
        files: { name: "note.txt", mimeType: "text/plain", buffer: Buffer.from("hello") }
      });

      expect(await getDropInfo(page)).toEqual({
        files: [{ name: "note.txt", type: "text/plain", size: 5, text: "hello" }],
        data: {}
      });
    });
  });

  it("drops multiple file payloads", async () => {
    await withPage(async (page) => {
      await setupDropzone(page);
      await page.locator("#dropzone").drop({
        files: [
          { name: "a.txt", mimeType: "text/plain", buffer: Buffer.from("AAA") },
          { name: "b.txt", mimeType: "text/plain", buffer: Buffer.from("BB") }
        ]
      });

      const info = await getDropInfo(page) as { files: Array<{ name: string; text: string }> };
      expect(info.files.map((file) => [file.name, file.text])).toEqual([["a.txt", "AAA"], ["b.txt", "BB"]]);
    });
  });

  it("drops a file by local path", async () => {
    await withPage(async (page) => {
      await setupDropzone(page);
      const filePath = join(tempDir, "hello.txt");
      await writeFile(filePath, "path-content");

      await page.locator("#dropzone").drop({ files: filePath });

      const info = await getDropInfo(page) as { files: Array<{ name: string; text: string }> };
      expect(info.files).toHaveLength(1);
      expect(info.files[0]?.name).toBe("hello.txt");
      expect(info.files[0]?.text).toBe("path-content");
    });
  });

  it("drops clipboard-like data", async () => {
    await withPage(async (page) => {
      await setupDropzone(page);
      await page.locator("#dropzone").drop({
        data: {
          "text/plain": "hello world",
          "text/uri-list": "https://example.com"
        }
      });

      expect(await getDropInfo(page)).toEqual({
        files: [],
        data: {
          "text/plain": "hello world",
          "text/uri-list": "https://example.com"
        }
      });
    });
  });

  it("throws when neither files nor data provided", async () => {
    await withPage(async (page) => {
      await setupDropzone(page);
      await expect(page.locator("#dropzone").drop({})).rejects.toThrow(/At least one of "files" or "data"/);
    });
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
