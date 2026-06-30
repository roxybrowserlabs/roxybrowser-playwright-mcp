import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { TestServer } from "./testserver.js";

export interface TestPageFixture {
  close(): Promise<void>;
  url: string;
}

export interface HistoryPageFixture extends TestPageFixture {
  asset(name: string): string;
  server: TestServer;
}

export interface HiddenUploadFixture extends TestPageFixture {
  server: TestServer;
  uploadPath: string;
}

export async function createTestPageFixture(): Promise<TestPageFixture> {
  const directory = await mkdtemp(join(tmpdir(), "roxybrowser-e2e-"));
  const filePath = join(directory, "app.html");

  await writeFile(
    filePath,
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Roxy E2E</title>
  </head>
  <body>
    <main>
      <label for="name">Name</label>
      <input id="name" aria-label="Name" />
      <button id="submit" type="button">Send</button>
      <div id="status">idle</div>
      <ul>
        <li>First item</li>
        <li>Second item</li>
      </ul>
    </main>
    <script>
      const input = document.getElementById("name");
      const status = document.getElementById("status");
      const submit = document.getElementById("submit");

      input.addEventListener("input", () => {
        status.textContent = "typing:" + input.value;
      });

      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          status.textContent = "submitted:" + input.value;
        }
      });

      submit.addEventListener("click", () => {
        status.textContent = "clicked:" + input.value;
      });
    </script>
  </body>
</html>`,
    "utf8"
  );

  return {
    url: pathToFileURL(filePath).toString(),
    close: async () => {
      await rm(directory, {
        force: true,
        recursive: true
      });
    }
  };
}

export async function createHistoryPageFixture(): Promise<HistoryPageFixture> {
  const assetRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "e2e", "assets");
  const consoleLogPath = join(assetRoot, "consolelog.html");
  const server = await TestServer.create(assetRoot);

  return {
    url: pathToFileURL(consoleLogPath).toString(),
    asset: (name: string) => join(assetRoot, name),
    server,
    close: async () => {
      await server.stop();
    }
  };
}

export async function createHiddenUploadFixture(): Promise<HiddenUploadFixture> {
  const assetRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "e2e", "assets");
  const server = await TestServer.create(assetRoot);
  const uploadPath = "/hidden-upload.html";

  server.setContent(
    uploadPath,
    `
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <title>Hidden Upload</title>
        </head>
        <body>
          <button id="upload-trigger" type="button">Select video</button>
          <input id="hidden-upload-input" type="file" style="display:none" />
          <div id="status">idle</div>
          <script>
            const trigger = document.getElementById("upload-trigger");
            const input = document.getElementById("hidden-upload-input");
            const status = document.getElementById("status");
            window.__uploadState = {
              events: [],
              fileCount: 0,
              fileName: null
            };

            trigger.addEventListener("click", () => {
              status.textContent = "chooser-opened";
              input.click();
            });

            input.addEventListener("input", () => {
              const file = input.files && input.files[0] ? input.files[0] : null;
              window.__uploadState.events.push("input");
              window.__uploadState.fileCount = input.files ? input.files.length : 0;
              window.__uploadState.fileName = file ? file.name : null;
              status.textContent = file ? "input:" + file.name : "input:empty";
            });

            input.addEventListener("change", () => {
              const file = input.files && input.files[0] ? input.files[0] : null;
              window.__uploadState.events.push("change");
              window.__uploadState.fileCount = input.files ? input.files.length : 0;
              window.__uploadState.fileName = file ? file.name : null;
              status.textContent = file ? "uploaded:" + file.name : "uploaded:empty";
            });
          </script>
        </body>
      </html>
    `,
    "text/html"
  );

  return {
    url: `${server.PREFIX}${uploadPath}`,
    uploadPath,
    server,
    close: async () => {
      await server.stop();
    }
  };
}
