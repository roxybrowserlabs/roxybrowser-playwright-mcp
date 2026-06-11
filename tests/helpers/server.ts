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
