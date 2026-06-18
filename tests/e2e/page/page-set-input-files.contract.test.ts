import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withPage } from "../../helpers/browser.js";
import { createHistoryPageFixture } from "../../helpers/server.js";

describe("page setInputFiles contract e2e", () => {
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

  it("uploads a file from an ElementHandle path", async () => {
    await withPage(async (page) => {
      await page.goto(fixture.server.PREFIX + "/input/fileupload.html");
      const filePath = relative(process.cwd(), fixture.asset("file-to-upload.txt"));
      const input = await page.$("input");

      await input!.setInputFiles(filePath);

      expect(await page.evaluate((element) => (element as HTMLInputElement).files![0].name, input)).toBe("file-to-upload.txt");
      expect(await page.evaluate((element) => {
        const reader = new FileReader();
        const promise = new Promise((resolve) => {
          reader.onload = resolve;
        });
        reader.readAsText((element as HTMLInputElement).files![0]);
        return promise.then(() => reader.result);
      }, input)).toBe(await readFile(fixture.asset("file-to-upload.txt"), "utf8"));
    });
  });

  it("uploads a file with spaces in name", async () => {
    await withPage(async (page) => {
      await page.setContent(`<input type=file>`);
      const directory = await mkdtemp(join(tmpdir(), "roxy-set-input-spaces-"));
      const filePath = join(directory, "file to upload.txt");
      await writeFile(filePath, "contents of the file");

      await page.setInputFiles("input", filePath);

      expect(await page.$eval("input", (input) => (input as HTMLInputElement).files![0].name)).toBe("file to upload.txt");
      expect(await page.$eval("input", (input) => {
        const reader = new FileReader();
        const promise = new Promise((resolve) => {
          reader.onload = resolve;
        });
        reader.readAsText((input as HTMLInputElement).files![0]);
        return promise.then(() => reader.result);
      })).toBe("contents of the file");
    });
  });

  it("sets from memory", async () => {
    await withPage(async (page) => {
      await page.setContent(`<input type=file>`);

      await page.setInputFiles("input", {
        name: "test.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("this is a test")
      });

      expect(await page.$eval("input", (input) => (input as HTMLInputElement).files!.length)).toBe(1);
      expect(await page.$eval("input", (input) => (input as HTMLInputElement).files![0].name)).toBe("test.txt");
    });
  });

  it("emits input and change events with Playwright composed semantics", async () => {
    await withPage(async (page) => {
      await page.setContent(`
        <body>
          <script>
            const div = document.createElement('div');
            const shadowRoot = div.attachShadow({ mode: 'open' });
            shadowRoot.innerHTML = '<input type=file></input>';
            document.body.appendChild(div);
          </script>
        </body>
      `);
      await page.locator("body").evaluate((body) => {
        (window as any).firedBodyEvents = [];
        for (const event of ["input", "change"]) {
          body.addEventListener(event, (e) => {
            (window as any).firedBodyEvents.push(e.type + ":" + e.composed);
          });
        }
      });
      await page.locator("input").evaluate((input) => {
        (window as any).firedEvents = [];
        for (const event of ["input", "change"]) {
          input.addEventListener(event, (e) => {
            (window as any).firedEvents.push(e.type + ":" + e.composed);
          });
        }
      });

      await page.locator("input").setInputFiles({
        name: "test.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("this is a test")
      });

      expect(await page.evaluate(() => (window as any).firedEvents)).toEqual(["input:true", "change:false"]);
      expect(await page.evaluate(() => (window as any).firedBodyEvents)).toEqual(["input:true"]);
    });
  });

  it("triggers events when files changed second time and clears with empty array", async () => {
    await withPage(async (page) => {
      await page.setContent(`<input type=file multiple>`);
      const input = page.locator("input");
      const events = await input.evaluateHandle((element) => {
        const fired: string[] = [];
        element.addEventListener("input", () => fired.push("input"));
        element.addEventListener("change", () => fired.push("change"));
        return fired;
      });

      await input.setInputFiles(fixture.asset("file-to-upload.txt"));
      expect(await input.evaluate((element) => (element as HTMLInputElement).files![0].name)).toBe("file-to-upload.txt");
      expect(await events.evaluate((fired) => fired)).toEqual(["input", "change"]);

      await events.evaluate((fired) => {
        fired.length = 0;
      });
      await input.setInputFiles(fixture.asset("pptr.png"));
      expect(await input.evaluate((element) => (element as HTMLInputElement).files![0].name)).toBe("pptr.png");
      expect(await events.evaluate((fired) => fired)).toEqual(["input", "change"]);

      await events.evaluate((fired) => {
        fired.length = 0;
      });
      await input.setInputFiles([]);
      expect(await input.evaluate((element) => (element as HTMLInputElement).files!.length)).toBe(0);
      expect(await events.evaluate((fired) => fired)).toEqual(["input", "change"]);
    });
  });

  it("rejects multiple files for a non-multiple input", async () => {
    await withPage(async (page) => {
      await page.setContent(`<input type=file>`);

      await expect(page.setInputFiles("input", [
        fixture.asset("file-to-upload.txt"),
        fixture.asset("pptr.png")
      ])).rejects.toThrow("Non-multiple file input can only accept single file");
    });
  });

  it("rejects missing file paths with ENOENT", async () => {
    await withPage(async (page) => {
      await page.setContent(`<input type=file>`);

      await expect(page.setInputFiles("input", "i actually do not exist.txt")).rejects.toThrow("ENOENT");
    });
  });

  it("rejects mixed paths and buffers", async () => {
    await withPage(async (page) => {
      await page.setContent(`<input type=file multiple>`);

      await expect(page.setInputFiles("input", [
        fixture.asset("file-to-upload.txt"),
        {
          name: "test.txt",
          mimeType: "text/plain",
          buffer: Buffer.from("this is a test")
        }
      ] as any)).rejects.toThrow("File paths cannot be mixed with buffers");
    });
  });

  it("uploads a folder and validates directory-only inputs", async () => {
    await withPage(async (page) => {
      await page.setContent(`<input type=file webkitdirectory>`);
      const directory = await mkdtemp(join(tmpdir(), "roxy-folder-upload-"));
      await writeFile(join(directory, "file1.txt"), "file1 content");
      await writeFile(join(directory, "file2"), "file2 content");
      await mkdir(join(directory, "sub-dir"));
      await writeFile(join(directory, "sub-dir", "really.txt"), "sub-dir file content");

      await page.setInputFiles("input", directory);
      const expectedRoot = basename(directory);

      expect(new Set(await page.$eval("input", (input) =>
        [...(input as HTMLInputElement).files!].map((file) => file.webkitRelativePath)
      ))).toEqual(new Set([
        expectedRoot + "/file1.txt",
        expectedRoot + "/file2",
        expectedRoot + "/sub-dir/really.txt"
      ]));
    });
  });

  it("rejects directory/file shape mismatches like Playwright", async () => {
    await withPage(async (page) => {
      const directory = await mkdtemp(join(tmpdir(), "roxy-directory-mismatch-"));
      await writeFile(join(directory, "file1.txt"), "file1 content");

      await page.setContent(`<input type=file>`);
      await expect(page.setInputFiles("input", directory)).rejects.toThrow(
        "File input does not support directories, pass individual files instead"
      );

      await page.setContent(`<input type=file webkitdirectory>`);
      await expect(page.setInputFiles("input", join(directory, "file1.txt"))).rejects.toThrow(
        "[webkitdirectory] input requires passing a path to a directory"
      );

      await mkdir(join(directory, "folder1"));
      await writeFile(join(directory, "folder1", "file1.txt"), "file1 content");
      await mkdir(join(directory, "folder2"));
      await writeFile(join(directory, "folder2", "file2.txt"), "file2 content");

      await expect(page.setInputFiles("input", [
        join(directory, "folder1"),
        join(directory, "folder2")
      ])).rejects.toThrow("Multiple directories are not supported");

      await expect(page.setInputFiles("input", [
        join(directory, "folder1"),
        join(directory, "folder1", "file1.txt")
      ])).rejects.toThrow("File paths must be all files or a single directory");
    });
  });
});
