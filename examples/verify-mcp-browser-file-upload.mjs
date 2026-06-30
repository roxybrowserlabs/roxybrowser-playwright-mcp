import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createRoxyBrowserMcpInMemory } from "../dist/mcp/index.js";

const endpoint = process.env.ROXY_CDP_ENDPOINT ?? "ws://127.0.0.1:56185/devtools/browser/5e0a2368-1186-450a-b3b4-775fc21c14ce";

const fixtureUrl = `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>MCP Browser File Upload Verify</title>
    <style>
      body {
        font-family: sans-serif;
        padding: 32px;
      }
      label {
        display: inline-flex;
        flex-direction: column;
        gap: 12px;
        font-size: 16px;
      }
      input[type="file"] {
        font-size: 14px;
      }
      pre {
        margin-top: 20px;
        padding: 12px;
        border-radius: 12px;
        background: #f5f7fa;
        white-space: pre-wrap;
      }
    </style>
  </head>
  <body>
    <label for="upload">
      Upload file
      <input id="upload" type="file" aria-label="Upload file" />
    </label>
    <pre id="status">idle</pre>
    <script>
      globalThis.__roxyUploadEvents = [];
      const input = document.getElementById("upload");
      const status = document.getElementById("status");

      input.addEventListener("click", () => {
        globalThis.__roxyUploadEvents.push("click");
      });

      input.addEventListener("focus", () => {
        globalThis.__roxyUploadEvents.push("focus");
      });

      input.addEventListener("change", async () => {
        const file = input.files?.[0] ?? null;
        if (!file) {
          status.textContent = "no-file";
          globalThis.__roxyUploadEvents.push("change:none");
          return;
        }
        const text = await file.text();
        globalThis.__roxyUploadEvents.push("change:" + file.name);
        status.textContent = JSON.stringify({
          name: file.name,
          size: file.size,
          type: file.type,
          text
        });
      });
    </script>
  </body>
</html>`)}`;

function textFromResult(result) {
  return (result.content ?? [])
    .filter((item) => item.type === "text")
    .map((item) => item.text ?? "")
    .join("\n");
}

async function callTool(client, name, args) {
  const result = await client.callTool({
    name,
    arguments: args
  });
  if (result.isError) {
    throw new Error(`${name} failed:\n${textFromResult(result)}`);
  }
  return result;
}

async function main() {
  const bundle = await createRoxyBrowserMcpInMemory();
  const client = new Client({ name: "verify-mcp-browser-file-upload", version: "1.0.0" });
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "roxy-upload-verify-"));
  const uploadPath = path.join(tempDir, "verify-upload.txt");

  try {
    await fs.writeFile(uploadPath, "uploaded through browser_file_upload");
    await client.connect(bundle.clientTransport);

    const connectResult = await callTool(client, "roxy_browser_connect", {
      browser: "chrome",
      endpoint
    });
    console.log("\n[connect]\n");
    console.log(textFromResult(connectResult));

    const navigateResult = await callTool(client, "browser_navigate", {
      url: fixtureUrl
    });
    console.log("\n[navigate]\n");
    console.log(textFromResult(navigateResult));

    const snapshotResult = await callTool(client, "browser_snapshot", {});
    const snapshotText = textFromResult(snapshotResult);
    console.log("\n[snapshot]\n");
    console.log(snapshotText);

    const clickResult = await callTool(client, "browser_click", {
      target: "#upload"
    });
    console.log("\n[click]\n");
    console.log(textFromResult(clickResult));

    const uploadResult = await callTool(client, "browser_file_upload", {
      paths: [uploadPath]
    });
    console.log("\n[file_upload]\n");
    console.log(textFromResult(uploadResult));

    const evaluateResult = await callTool(client, "browser_evaluate", {
      function: `() => ({
        status: document.querySelector("#status")?.textContent ?? null,
        files: Array.from(document.querySelector("#upload")?.files ?? []).map((file) => ({
          name: file.name,
          size: file.size,
          type: file.type
        })),
        uploadEvents: globalThis.__roxyUploadEvents ?? [],
        bubbleInstalled: Boolean(globalThis.__roxyBubbleCursor?.installed)
      })`
    });
    const evaluateText = textFromResult(evaluateResult);
    console.log("\n[evaluate]\n");
    console.log(evaluateText);

    const parsed = JSON.parse(evaluateText.replace(/^### Result\s*/, ""));
    const status = JSON.parse(parsed.status);
    if (status.name !== "verify-upload.txt") {
      throw new Error(`Expected uploaded file name to be "verify-upload.txt", received "${status.name}".`);
    }
    if (status.text !== "uploaded through browser_file_upload") {
      throw new Error(`Expected uploaded file text to match fixture, received "${status.text}".`);
    }
    if (parsed.files.length !== 1) {
      throw new Error(`Expected exactly 1 uploaded file, received ${parsed.files.length}.`);
    }

    console.log("\nVerification passed.");
    console.log(`- uploaded file name: ${status.name}`);
    console.log(`- uploaded file text: ${status.text}`);
    console.log(`- upload events: ${parsed.uploadEvents.join(", ")}`);
    console.log(`- bubble cursor installed: ${parsed.bubbleInstalled}`);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    await client.close().catch(() => {});
    await bundle.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
