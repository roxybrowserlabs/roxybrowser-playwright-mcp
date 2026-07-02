import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import * as cdpModule from "chrome-remote-interface";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createRoxyBrowserMcpInMemory } from "../../dist/mcp/index.js";

const options = parseArgs(process.argv.slice(2));
const endpoint = options.cdpEndpoint;
const chromeRemoteInterface =
  "default" in cdpModule ? cdpModule.default : cdpModule;
const fixtureUrl = 'https://www.tiktok.com/';
const waitSeconds = options.waitSeconds;

function parseArgs(argv) {
  const flagIndex = argv.findIndex((arg) => arg === "--cdp-endpoint" || arg === "--endpoint");
  const endpointArg = flagIndex >= 0 ? argv[flagIndex + 1] : argv.find((arg) => !arg.startsWith("-"));
  if (!endpointArg) {
    throw new Error([
      "Missing CDP endpoint.",
      "Usage:",
      "  pnpm examples mcp print-browser-snapshots -- --cdp-endpoint ws://127.0.0.1:9222/devtools/browser/<id> [--wait 5]",
      "  node examples/mcp/print-browser-snapshots.mjs ws://127.0.0.1:9222/devtools/browser/<id>"
    ].join("\n"));
  }
  const waitFlagIndex = argv.findIndex((arg) => arg === "--wait" || arg === "--wait-seconds");
  const waitValue = waitFlagIndex >= 0 ? argv[waitFlagIndex + 1] : undefined;
  const parsedWait = waitValue === undefined ? 5 : Number(waitValue);
  if (!Number.isFinite(parsedWait) || parsedWait < 0) {
    throw new Error(`Invalid --wait value "${waitValue}". Expected a non-negative number of seconds.`);
  }
  return {
    cdpEndpoint: endpointArg,
    waitSeconds: parsedWait
  };
}

function textFromResult(result) {
  return (result.content ?? [])
    .filter((item) => item.type === "text")
    .map((item) => item.text ?? "")
    .join("\n");
}

async function callTool(client, name, args = {}) {
  const result = await client.callTool({
    name,
    arguments: args
  });
  if (result.isError) {
    throw new Error(`${name} failed:\n${textFromResult(result)}`);
  }
  return result;
}

async function pageDiagnostics(client) {
  return textFromResult(await callTool(client, "browser_evaluate", {
    function: `() => {
      const main = document.querySelector("main");
      return {
        url: location.href,
        title: document.title,
        readyState: document.readyState,
        bodyTextLength: document.body?.innerText?.length ?? 0,
        mainTextLength: main?.innerText?.length ?? 0,
        mainChildCount: main?.children.length ?? 0,
        articleCount: document.querySelectorAll("article").length,
        visibleArticleCount: Array.from(document.querySelectorAll("article")).filter((article) => {
          const rect = article.getBoundingClientRect();
          const style = getComputedStyle(article);
          return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
        }).length,
        firstImageAlts: Array.from(document.querySelectorAll("main img[alt]"))
          .slice(0, 5)
          .map((img) => img.getAttribute("alt"))
      };
    }`
  }));
}

function createClient(name) {
  return new Client({
    name,
    version: "1.0.0"
  });
}

function playwrightMcpCliPath() {
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve("@playwright/mcp/package.json")), "cli.js");
}

async function waitForSnapshotWindow(client) {
  if (waitSeconds <= 0) {
    return;
  }
  await callTool(client, "browser_wait_for", { time: waitSeconds });
}

async function resetCdpPagesToSingleBlankTab() {
  const connection = await cdpBrowserConnection(endpoint);
  const client = await chromeRemoteInterface(connection);

  try {
    const before = await client.Target.getTargets();
    const fresh = await client.Target.createTarget({ url: "about:blank" });
    await client.Target.activateTarget({ targetId: fresh.targetId });

    await Promise.all(
      before.targetInfos
        .filter((target) => target.type === "page" && target.targetId !== fresh.targetId)
        .map((target) =>
          client.Target.closeTarget({ targetId: target.targetId }).catch(() => undefined)
        )
    );
  } finally {
    await client.close();
  }
}

async function cdpBrowserConnection(cdpEndpoint) {
  const url = new URL(cdpEndpoint);
  if (url.protocol === "ws:" || url.protocol === "wss:") {
    return {
      host: url.hostname,
      port: Number(url.port),
      target: cdpEndpoint
    };
  }

  const versionUrl = new URL("/json/version", url);
  const response = await fetch(versionUrl);
  if (!response.ok) {
    throw new Error(`Unable to read CDP version endpoint at ${versionUrl.toString()}.`);
  }
  const version = await response.json();
  if (typeof version.webSocketDebuggerUrl !== "string") {
    throw new Error("CDP version endpoint did not include webSocketDebuggerUrl.");
  }
  const ws = new URL(version.webSocketDebuggerUrl);
  return {
    host: ws.hostname,
    port: Number(ws.port),
    target: version.webSocketDebuggerUrl
  };
}

async function createRoxyMcpClient() {
  const bundle = await createRoxyBrowserMcpInMemory({ snapshotMode: "none" });
  const client = createClient("print-roxy-browser-snapshot");

  try {
    await client.connect(bundle.clientTransport);
  } catch (error) {
    await client.close().catch(() => {});
    await bundle.close().catch(() => {});
    throw error;
  }

  return {
    client,
    close: async () => {
      await client.close().catch(() => {});
      await bundle.close().catch(() => {});
    }
  };
}

async function prepareRoxyTab(client) {
    await callTool(client, "roxy_browser_connect", {
      browser: "chrome",
      endpoint
    });
    await callTool(client, "browser_tabs", {
      action: "select",
      index: 0
    });
    await callTool(client, "browser_navigate", { url: fixtureUrl });
}

async function snapshotWithRoxyMcp(client) {
  await callTool(client, "browser_tabs", {
    action: "select",
    index: 0
  });
  return {
    diagnostics: await pageDiagnostics(client),
    snapshot: textFromResult(await callTool(client, "browser_snapshot"))
  };
}

async function createPlaywrightMcpClient() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      playwrightMcpCliPath(),
      "--cdp-endpoint",
      endpoint,
      "--browser",
      "chromium",
      "--snapshot-mode",
      "none"
    ],
    cwd: process.cwd(),
    stderr: "pipe"
  });
  const stderrChunks = [];
  transport.stderr?.on("data", (chunk) => stderrChunks.push(String(chunk)));

  const client = createClient("print-playwright-browser-snapshot");
  try {
    await client.connect(transport);
  } catch (error) {
    const stderr = stderrChunks.join("").trim();
    throw new Error(
      `Unable to start Playwright MCP.${stderr ? `\n\nstderr:\n${stderr}` : ""}\n\n${String(error)}`
    );
  }

  return {
    client,
    close: async () => {
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
    }
  };
}

async function preparePlaywrightTab(client) {
  await callTool(client, "browser_tabs", {
    action: "new",
    url: fixtureUrl
  });
  await callTool(client, "browser_tabs", {
    action: "select",
    index: 1
  });
}

async function snapshotWithPlaywrightMcp(client) {
  await callTool(client, "browser_tabs", {
    action: "select",
    index: 1
  });
  return {
    diagnostics: await pageDiagnostics(client),
    snapshot: textFromResult(await callTool(client, "browser_snapshot"))
  };
}

async function main() {
  await resetCdpPagesToSingleBlankTab();

  const roxy = await createRoxyMcpClient();
  const playwright = await createPlaywrightMcpClient();

  try {
    await prepareRoxyTab(roxy.client);
    await preparePlaywrightTab(playwright.client);

    console.log(`\n=== Waiting ${waitSeconds}s before both snapshots ===\n`);
    await Promise.all([
      waitForSnapshotWindow(roxy.client),
      waitForSnapshotWindow(playwright.client)
    ]);

    const roxySnapshot = await snapshotWithRoxyMcp(roxy.client);
    console.log("\n=== RoxyBrowser MCP diagnostics (tab 0) ===\n");
    console.log(roxySnapshot.diagnostics);
    console.log("\n=== RoxyBrowser MCP browser_snapshot (tab 0) ===\n");
    console.log(roxySnapshot.snapshot);

    const playwrightSnapshot = await snapshotWithPlaywrightMcp(playwright.client);
    console.log("\n=== Playwright MCP diagnostics (tab 1) ===\n");
    console.log(playwrightSnapshot.diagnostics);
    console.log("\n=== Playwright MCP browser_snapshot (tab 1) ===\n");
    console.log(playwrightSnapshot.snapshot);
  } finally {
    await playwright.close();
    await roxy.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
