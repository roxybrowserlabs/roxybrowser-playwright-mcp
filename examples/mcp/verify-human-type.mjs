import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createRoxyBrowserMcpInMemory } from "../../dist/mcp/index.js";
import { requiredCdpEndpoint } from "./helpers/env.mjs";

const endpoint = requiredCdpEndpoint();

const fixtureUrl = `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>MCP Human Type Verify</title>
    <style>
      body {
        font-family: sans-serif;
        padding: 32px;
      }
      input {
        width: 320px;
        padding: 10px 12px;
        font-size: 16px;
      }
    </style>
  </head>
  <body>
    <label for="search">Search</label>
    <input id="search" aria-label="Search" value="existing query" />
    <script>
      window.__roxyInputEvents = [];
      const input = document.querySelector("#search");
      input.addEventListener("focus", () => window.__roxyInputEvents.push("focus"));
      input.addEventListener("input", () => window.__roxyInputEvents.push("input:" + input.value));
      input.addEventListener("change", () => window.__roxyInputEvents.push("change:" + input.value));
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
  const client = new Client({ name: "verify-mcp-human-type", version: "1.0.0" });

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

    const inputRefMatch = snapshotText.match(/textbox "Search" \[active\]? ?\[ref=(e\d+)\]/)
      ?? snapshotText.match(/textbox "Search" \[ref=(e\d+)\]/);
    if (!inputRefMatch) {
      throw new Error("Could not find the Search textbox ref in browser_snapshot output.");
    }
    const target = inputRefMatch[1];

    const typeResult = await callTool(client, "browser_type", {
      target,
      text: "fresh search"
    });
    console.log("\n[type]\n");
    console.log(textFromResult(typeResult));

    const evaluateResult = await callTool(client, "browser_evaluate", {
      function: `() => ({
        value: document.querySelector("#search")?.value ?? null,
        activeId: document.activeElement?.id ?? null,
        inputEvents: globalThis.__roxyInputEvents ?? [],
        bubbleInstalled: Boolean(globalThis.__roxyBubbleCursor?.installed),
        bubbleState: globalThis.__roxyBubbleCursor ?? null
      })`
    });
    const evaluateText = textFromResult(evaluateResult);
    console.log("\n[evaluate]\n");
    console.log(evaluateText);

    const parsed = JSON.parse(evaluateText.replace(/^### Result\s*/, ""));
    if (parsed.value !== "fresh search") {
      throw new Error(`Expected input value to be "fresh search", received "${parsed.value}".`);
    }
    if (parsed.activeId !== "search") {
      throw new Error(`Expected active element to be "#search", received "${parsed.activeId}".`);
    }

    console.log("\nVerification passed.");
    console.log("- old input value was replaced");
    console.log("- input stayed focused");
    console.log(`- bubble cursor installed: ${parsed.bubbleInstalled}`);
    console.log("\nIf you want to visually inspect motion, keep the browser open and rerun browser_type manually.");
  } finally {
    await client.close().catch(() => {});
    await bundle.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
