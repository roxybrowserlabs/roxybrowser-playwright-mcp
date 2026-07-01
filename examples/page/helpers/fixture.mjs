import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export async function createExampleFixture() {
  const directory = await mkdtemp(join(tmpdir(), "roxybrowser-example-"));
  const filePath = join(directory, "app.html");

  await writeFile(
    filePath,
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Roxy Example</title>
  </head>
  <body>
    <main>
      <label for="name">Name</label>
      <input id="name" aria-label="Name" />
      <button id="submit" type="button">Send</button>
      <div id="status">idle</div>
    </main>
    <script>
      const input = document.getElementById("name");
      const status = document.getElementById("status");
      const submit = document.getElementById("submit");

      input.addEventListener("input", () => {
        status.textContent = "typing:" + input.value;
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
