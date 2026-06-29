import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createRoxyBrowserMcpInMemory } from "../dist/mcp/index.js";

const endpoint = process.env.ROXY_CDP_ENDPOINT ?? "ws://127.0.0.1:59330/devtools/browser/53a1ebbd-37ee-4f4b-aa12-51496bdfc4f1";

const fixtureUrl = `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>MCP Browser Drag Verify</title>
    <style>
      body {
        font-family: sans-serif;
        padding: 32px;
      }
      .board {
        display: flex;
        gap: 28px;
        align-items: flex-start;
      }
      .card {
        width: 120px;
        height: 120px;
        border-radius: 18px;
        background: linear-gradient(160deg, #ffb089, #f26f4f);
        box-shadow: 0 12px 30px rgba(242, 111, 79, 0.25);
        cursor: grab;
      }
      .dropzone {
        width: 220px;
        min-height: 180px;
        padding: 18px;
        border: 2px dashed #7a8795;
        border-radius: 22px;
        background: linear-gradient(180deg, #f8fbfd, #edf3f7);
      }
      .status {
        margin-top: 18px;
        font-size: 14px;
      }
    </style>
  </head>
  <body>
    <div class="board">
      <div id="source" class="card" draggable="true" aria-label="Source card"></div>
      <div id="target" class="dropzone" aria-label="Drop zone">
        <div id="drop-label">Drop here</div>
      </div>
    </div>
    <div id="status" class="status">idle</div>
    <script>
      globalThis.__roxyDragEvents = [];
      const source = document.getElementById("source");
      const target = document.getElementById("target");
      const status = document.getElementById("status");

      source.addEventListener("dragstart", (event) => {
        globalThis.__roxyDragEvents.push("dragstart");
        event.dataTransfer?.setData("text/plain", "source-card");
        status.textContent = "dragstart";
      });

      target.addEventListener("dragenter", (event) => {
        event.preventDefault();
        globalThis.__roxyDragEvents.push("dragenter");
      });

      target.addEventListener("dragover", (event) => {
        event.preventDefault();
        globalThis.__roxyDragEvents.push("dragover");
      });

      target.addEventListener("drop", (event) => {
        event.preventDefault();
        const payload = event.dataTransfer?.getData("text/plain") ?? "";
        globalThis.__roxyDragEvents.push("drop:" + payload);
        target.dataset.received = payload;
        status.textContent = "dropped:" + payload;
        document.getElementById("drop-label").textContent = "Dropped " + payload;
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
  const client = new Client({ name: "verify-mcp-browser-drag", version: "1.0.0" });

  try {
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

    const sourceRefMatch = snapshotText.match(/generic "Source card" \[ref=(e\d+)\]/)
      ?? snapshotText.match(/generic \[ref=(e\d+)\]/);
    const targetRefMatch = snapshotText.match(/generic "Drop zone" \[ref=(e\d+)\]/)
      ?? [...snapshotText.matchAll(/\[ref=(e\d+)\]/g)][1];

    if (!sourceRefMatch || !targetRefMatch) {
      throw new Error("Could not find source/target refs in browser_snapshot output.");
    }

    const dragResult = await callTool(client, "browser_drag", {
      startTarget: sourceRefMatch[1],
      endTarget: targetRefMatch[1]
    });
    console.log("\n[drag]\n");
    console.log(textFromResult(dragResult));

    const evaluateResult = await callTool(client, "browser_evaluate", {
      function: `() => ({
        status: document.querySelector("#status")?.textContent ?? null,
        received: document.querySelector("#target")?.dataset?.received ?? null,
        dragEvents: globalThis.__roxyDragEvents ?? [],
        bubbleInstalled: Boolean(globalThis.__roxyBubbleCursor?.installed)
      })`
    });
    const evaluateText = textFromResult(evaluateResult);
    console.log("\n[evaluate]\n");
    console.log(evaluateText);

    const parsed = JSON.parse(evaluateText.replace(/^### Result\s*/, ""));
    if (parsed.received !== "source-card") {
      throw new Error(`Expected drop payload to be "source-card", received "${parsed.received}".`);
    }

    console.log("\nVerification passed.");
    console.log(`- drag payload received: ${parsed.received}`);
    console.log(`- drag events: ${parsed.dragEvents.join(", ")}`);
    console.log(`- bubble cursor installed: ${parsed.bubbleInstalled}`);
  } finally {
    await client.close().catch(() => {});
    await bundle.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
