import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as cdpModule from "chrome-remote-interface";
import { chromium } from "playwright";
import { createRoxyBrowserMcpInMemory } from "../../src/mcp/index.js";
import { createHiddenUploadFixture } from "../helpers/server.js";
import { resolveRoxyBrowserEndpoint } from "../helpers/roxybrowser.js";

const ROXYBROWSER_API_PORT = process.env.ROXYBROWSER_API_PORT ?? "50000";
const ROXYBROWSER_API_TOKEN = process.env.ROXYBROWSER_API_TOKEN;
const VIEWPORT = { width: 1280, height: 720 };
const describeWithCdp = ROXYBROWSER_API_TOKEN ? describe : describe.skip;
const chromeRemoteInterface = ("default" in cdpModule
  ? cdpModule.default
  : cdpModule) as unknown as {
  (options: {
    host?: string;
    port?: number;
    target?: string;
  }): Promise<CdpBrowserClient>;
};

type CdpBrowserClient = {
  close(): Promise<void>;
  Target: {
    getTargets(): Promise<{ targetInfos: Array<{ targetId: string; type: string; url: string }> }>;
    createTarget(options: { url: string }): Promise<{ targetId: string }>;
    activateTarget(options: { targetId: string }): Promise<void>;
    closeTarget(options: { targetId: string }): Promise<void>;
  };
};

describeWithCdp("MCP hidden input file upload contract", () => {
  let fixture: Awaited<ReturnType<typeof createHiddenUploadFixture>>;
  let tempDir: string;
  let uploadFilePath: string;
  const cleanupCallbacks: Array<() => Promise<void>> = [];

  beforeAll(async () => {
    fixture = await createHiddenUploadFixture();
    tempDir = await mkdtemp(join(tmpdir(), "roxybrowser-mcp-upload-"));
    uploadFilePath = join(tempDir, "upload.txt");
    await writeFile(uploadFilePath, "hidden input upload", "utf8");
  });

  beforeEach(() => {
    fixture.server.reset();
    fixture.server.setContent(
      fixture.uploadPath,
      `
        <html lang="en">
          <head>
            <meta charset="utf-8" />
            <title>Hidden Upload</title>
          </head>
          <body>
            <button id="upload-trigger" type="button">Select video</button>
            <input id="hidden-upload-input" type="file" style="display:none" />
            <div
              id="status"
              data-events=""
              data-state-file-count="0"
              data-state-file-name=""
            >idle</div>
            <script>
              const trigger = document.getElementById("upload-trigger");
              const input = document.getElementById("hidden-upload-input");
              const status = document.getElementById("status");
              const writeState = () => {
                status.dataset.events = window.__uploadState.events.join(",");
                status.dataset.stateFileCount = String(window.__uploadState.fileCount);
                status.dataset.stateFileName = window.__uploadState.fileName ?? "";
              };
              window.__uploadState = { events: [], fileCount: 0, fileName: null };
              writeState();
              trigger.addEventListener("click", () => {
                status.textContent = "chooser-opened";
                input.click();
              });
              input.addEventListener("input", () => {
                const file = input.files && input.files[0] ? input.files[0] : null;
                window.__uploadState.events.push("input");
                window.__uploadState.fileCount = input.files ? input.files.length : 0;
                window.__uploadState.fileName = file ? file.name : null;
                writeState();
                status.textContent = file ? "input:" + file.name : "input:empty";
              });
              input.addEventListener("change", () => {
                const file = input.files && input.files[0] ? input.files[0] : null;
                window.__uploadState.events.push("change");
                window.__uploadState.fileCount = input.files ? input.files.length : 0;
                window.__uploadState.fileName = file ? file.name : null;
                writeState();
                status.textContent = file ? "uploaded:" + file.name : "uploaded:empty";
              });
            </script>
          </body>
        </html>
      `,
      "text/html"
    );
  });

  afterAll(async () => {
    while (cleanupCallbacks.length > 0) {
      await cleanupCallbacks.pop()?.();
    }
    await fixture.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("uploads to a hidden file input triggered by a visible button without a target parameter", async () => {
    const cdpEndpoint = await createPreparedPage(fixture.url);
    const roxy = await createRoxyMcpClient(cleanupCallbacks);
    await connectRoxyToCdp(roxy.client, cdpEndpoint);
    expect(roxy.runtimeChooserSupport()).toEqual({
      protocol: "cdp",
      constructorName: "CdpConnectedBrowserSession"
    });

    const snapshot = await callTool(roxy.client, "browser_snapshot", {});
    const snapshotText = textFromResult(snapshot);
    expect(snapshotText).toContain(`- button "Select video"`);
    const buttonRef = refForButton(snapshotText, "Select video");

    const click = await callTool(roxy.client, "browser_click", { target: buttonRef, element: "Select video" });
    expect(click.isError).toBeUndefined();
    expect(roxy.fileChooserDebugState()).toMatchObject({
      prepareCalls: 1,
      chooserEvents: 1,
      capturedTargets: 1,
      interceptEnabledTabCount: 1,
      pendingTargetCount: 0
    });
    expect(roxy.hasPendingFileUploadTarget()).toBe(true);

    const blockedHover = await callTool(roxy.client, "browser_type", {
      target: buttonRef,
      element: "Select video",
      text: "blocked"
    });
    if (!blockedHover.isError) {
      throw new Error(`Expected pending file chooser modal state after click.\n${textFromResult(blockedHover)}`);
    }
    expect(textFromResult(blockedHover)).toContain('does not handle the modal state');

    const upload = await callTool(roxy.client, "browser_file_upload", {
      paths: [uploadFilePath]
    });
    if (upload.isError) {
      throw new Error(`browser_file_upload failed:\n${textFromResult(upload)}`);
    }
    expect(upload.isError).toBeUndefined();
    expect(textFromResult(upload)).toContain("Uploaded 1 file(s).");

    const evaluation = await callTool(roxy.client, "browser_evaluate", {
      function: `() => {
        const input = document.getElementById("hidden-upload-input");
        const status = document.getElementById("status");
        return {
          status: status?.textContent ?? null,
          fileCount: input?.files?.length ?? 0,
          fileName: input?.files?.[0]?.name ?? null,
          events: status?.dataset.events ? status.dataset.events.split(",").filter(Boolean) : [],
          stateFileCount: Number(status?.dataset.stateFileCount ?? "0"),
          stateFileName: status?.dataset.stateFileName || null
        };
      }`
    });
    const parsed = parseJsonResultBlock(textFromResult(evaluation));

    expect(parsed.status).toBe("uploaded:upload.txt");
    expect(parsed.fileCount).toBe(1);
    expect(parsed.fileName).toBe("upload.txt");
    expect(parsed.stateFileCount).toBe(1);
    expect(parsed.stateFileName).toBe("upload.txt");
    expect(parsed.events).toEqual(["input", "change"]);
  });

  it("waits for post-upload UI to settle before returning the snapshot", async () => {
    fixture.server.reset();
    fixture.server.setRoute("/upload-ready.json", async (_request, response) => {
      await new Promise((resolve) => setTimeout(resolve, 700));
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ready: true }));
    });
    fixture.server.setContent(
      fixture.uploadPath,
      `
        <html lang="en">
          <head>
            <meta charset="utf-8" />
            <title>Upload Settling</title>
          </head>
          <body>
            <button id="upload-trigger" type="button">Select video</button>
            <input id="hidden-upload-input" type="file" style="display:none" />
            <button id="post-button" type="button" aria-disabled="true" disabled style="cursor: default;">Post</button>
            <script>
              const trigger = document.getElementById("upload-trigger");
              const input = document.getElementById("hidden-upload-input");
              const postButton = document.getElementById("post-button");
              trigger.addEventListener("click", () => {
                input.click();
              });
              input.addEventListener("change", () => {
                postButton.setAttribute("aria-disabled", "true");
                postButton.setAttribute("disabled", "");
                fetch("/upload-ready.json")
                  .then((response) => response.json())
                  .then(() => {
                    postButton.removeAttribute("disabled");
                    postButton.setAttribute("aria-disabled", "false");
                    postButton.style.cursor = "pointer";
                  });
              });
            </script>
          </body>
        </html>
      `,
      "text/html"
    );

    const cdpEndpoint = await createPreparedPage(fixture.url);
    const roxy = await createRoxyMcpClient(cleanupCallbacks);
    await connectRoxyToCdp(roxy.client, cdpEndpoint);

    const snapshot = await callTool(roxy.client, "browser_snapshot", {});
    const buttonRef = refForButton(textFromResult(snapshot), "Select video");

    await callTool(roxy.client, "browser_click", { target: buttonRef, element: "Select video" });
    const uploadReadyRequest = fixture.server.waitForRequest("/upload-ready.json");
    const upload = await callTool(roxy.client, "browser_file_upload", {
      paths: [uploadFilePath]
    });
    await uploadReadyRequest;
    const uploadText = textFromResult(upload);
    const requests = await callTool(roxy.client, "browser_network_requests", {});
    await callTool(roxy.client, "browser_evaluate", {
      function: `async () => {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        return true;
      }`
    });
    const postButtonState = await callTool(roxy.client, "browser_evaluate", {
      function: `() => {
        const button = document.getElementById("post-button");
        const style = button ? getComputedStyle(button) : null;
        return {
          ariaDisabled: button?.getAttribute("aria-disabled") ?? null,
          disabledAttribute: button?.getAttribute("disabled") ?? null,
          disabledProperty: button instanceof HTMLButtonElement ? button.disabled : null,
          cursor: style?.cursor ?? null,
          html: button?.outerHTML ?? null
        };
      }`
    });

    expect(uploadText).toContain('button "Post"');
    expect(textFromResult(requests)).toContain("/upload-ready.json");
    expect(textFromResult(postButtonState)).toContain('"ariaDisabled": "false"');
    expect(textFromResult(postButtonState)).toContain('"disabledAttribute": null');
    expect(textFromResult(postButtonState)).toContain('"disabledProperty": false');
    expect(textFromResult(postButtonState)).toContain('"cursor": "pointer"');
    expect(uploadText).toContain('[cursor=pointer]');
    expect(uploadText).not.toContain('button "Post" [disabled]');
  });

  it("keeps the post button disabled when the upload-ready request fails", async () => {
    fixture.server.reset();
    fixture.server.setRoute("/upload-ready.json", async (_request, response) => {
      await new Promise((resolve) => setTimeout(resolve, 700));
      response.writeHead(500, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ready: false, error: "server failed" }));
    });
    fixture.server.setContent(
      fixture.uploadPath,
      `
        <html lang="en">
          <head>
            <meta charset="utf-8" />
            <title>Upload Settling Failure</title>
          </head>
          <body>
            <button id="upload-trigger" type="button">Select video</button>
            <input id="hidden-upload-input" type="file" style="display:none" />
            <button id="post-button" type="button" aria-disabled="true" disabled style="cursor: default;">Post</button>
            <script>
              const trigger = document.getElementById("upload-trigger");
              const input = document.getElementById("hidden-upload-input");
              const postButton = document.getElementById("post-button");
              trigger.addEventListener("click", () => {
                input.click();
              });
              input.addEventListener("change", () => {
                postButton.setAttribute("aria-disabled", "true");
                postButton.setAttribute("disabled", "");
                fetch("/upload-ready.json")
                  .then(async (response) => {
                    if (!response.ok) {
                      throw new Error("upload-ready failed: " + response.status);
                    }
                    return response.json();
                  })
                  .then(() => {
                    postButton.removeAttribute("disabled");
                    postButton.setAttribute("aria-disabled", "false");
                    postButton.style.cursor = "pointer";
                  })
                  .catch(() => {
                    postButton.setAttribute("data-error", "upload-ready-failed");
                  });
              });
            </script>
          </body>
        </html>
      `,
      "text/html"
    );

    const cdpEndpoint = await createPreparedPage(fixture.url);
    const roxy = await createRoxyMcpClient(cleanupCallbacks);
    await connectRoxyToCdp(roxy.client, cdpEndpoint);

    const snapshot = await callTool(roxy.client, "browser_snapshot", {});
    const buttonRef = refForButton(textFromResult(snapshot), "Select video");

    await callTool(roxy.client, "browser_click", { target: buttonRef, element: "Select video" });
    const uploadReadyRequest = fixture.server.waitForRequest("/upload-ready.json");
    const upload = await callTool(roxy.client, "browser_file_upload", {
      paths: [uploadFilePath]
    });
    await uploadReadyRequest;

    const uploadText = textFromResult(upload);
    const postButtonState = await callTool(roxy.client, "browser_evaluate", {
      function: `async () => {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const button = document.getElementById("post-button");
        const style = button ? getComputedStyle(button) : null;
        return {
          ariaDisabled: button?.getAttribute("aria-disabled") ?? null,
          disabledAttribute: button?.getAttribute("disabled") ?? null,
          disabledProperty: button instanceof HTMLButtonElement ? button.disabled : null,
          cursor: style?.cursor ?? null,
          error: button?.getAttribute("data-error") ?? null,
          html: button?.outerHTML ?? null
        };
      }`
    });

    expect(uploadText).toContain('button "Post" [disabled]');
    expect(textFromResult(postButtonState)).toContain('"ariaDisabled": "true"');
    expect(textFromResult(postButtonState)).toContain('"disabledAttribute": ""');
    expect(textFromResult(postButtonState)).toContain('"disabledProperty": true');
    expect(textFromResult(postButtonState)).toContain('"cursor": "default"');
    expect(textFromResult(postButtonState)).toContain('"error": "upload-ready-failed"');
  });
});

async function createPreparedPage(url: string): Promise<string> {
  const cdpEndpoint = await resolveCdpEndpoint();
  await resetCdpPages(cdpEndpoint);
  await preparePageWithPlaywright(cdpEndpoint, url);
  return cdpEndpoint;
}

async function createRoxyMcpClient(cleanupCallbacks: Array<() => Promise<void>>): Promise<{
  client: Client;
  getLastSessionId(): string | undefined;
  hasPendingFileUploadTarget(): boolean;
  runtimeChooserSupport(): {
    protocol: string | undefined;
    constructorName: string;
  };
  fileChooserDebugState(): {
    prepareCalls: number;
    chooserEvents: number;
    capturedTargets: number;
    eventDispatchCalls: number;
    eventDispatchSuccesses: number;
    lastEventDispatchError: string;
    interceptEnabledTabCount: number;
    pendingTargetCount: number;
  } | null;
}> {
  const roxyBundle = await createRoxyBrowserMcpInMemory({ snapshotMode: "full" });
  cleanupCallbacks.push(async () => roxyBundle.close());

  const roxyClient = createClient("roxy-mcp-hidden-upload-contract-client");
  cleanupCallbacks.push(async () => roxyClient.close());
  await roxyClient.connect(roxyBundle.clientTransport);

  return {
    client: roxyClient,
    getLastSessionId: () => roxyBundle.getLastSessionId?.(),
    hasPendingFileUploadTarget: () => {
      const sessionId = roxyBundle.getLastSessionId?.();
      return roxyBundle.runtimeManager.getRuntime(sessionId).hasPendingFileUploadTarget();
    },
    runtimeChooserSupport: () => {
      const sessionId = roxyBundle.getLastSessionId?.();
      const runtime = roxyBundle.runtimeManager.getRuntime(sessionId) as unknown as {
        requireConnected(): {
          protocol?: string;
          constructor?: { name?: string };
        };
      };
      const session = runtime.requireConnected();
      return {
        protocol: session.protocol,
        constructorName: session.constructor?.name ?? "unknown"
      };
    },
    fileChooserDebugState: () => {
      const sessionId = roxyBundle.getLastSessionId?.();
      const runtime = roxyBundle.runtimeManager.getRuntime(sessionId) as unknown as {
        requireConnected(): {
          debugFileChooserState?: () => {
            prepareCalls: number;
            chooserEvents: number;
            capturedTargets: number;
            eventDispatchCalls: number;
            eventDispatchSuccesses: number;
            lastEventDispatchError: string;
            interceptEnabledTabCount: number;
            pendingTargetCount: number;
          };
        };
      };
      const session = runtime.requireConnected();
      return typeof session.debugFileChooserState === "function"
        ? session.debugFileChooserState()
        : null;
    }
  };
}

async function connectRoxyToCdp(roxyClient: Client, cdpEndpoint: string): Promise<void> {
  const connectResult = await callTool(roxyClient, "roxy_browser_connect", {
    endpoint: cdpEndpoint,
    browser: "chrome"
  });
  assertToolSucceeded("Roxy MCP roxy_browser_connect", connectResult);
}

async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>
): Promise<CallToolResult> {
  return client.callTool({
    name,
    arguments: args
  }) as Promise<CallToolResult>;
}

function createClient(name: string): Client {
  return new Client({
    name,
    version: "1.0.0"
  });
}

async function preparePageWithPlaywright(cdpEndpoint: string, url: string): Promise<void> {
  const browser = await chromium.connect(cdpEndpoint);
  try {
    const context = browser.contexts()[0] ?? await browser.newContext();
    const page = context.pages()[0] ?? await context.newPage();
    await page.setViewportSize(VIEWPORT);
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("load", { timeout: 5_000 }).catch(() => undefined);
  } finally {
    await browser.close();
  }
}

async function resetCdpPages(cdpEndpoint: string): Promise<void> {
  const connection = await cdpBrowserConnection(cdpEndpoint);
  const client = await chromeRemoteInterface(connection);
  try {
    const before = await client.Target.getTargets();
    const fresh = await client.Target.createTarget({ url: "about:blank" });
    await client.Target.activateTarget({ targetId: fresh.targetId });

    await Promise.all(
      before.targetInfos
        .filter((target) => target.type === "page" && target.targetId !== fresh.targetId)
        .map((target) => client.Target.closeTarget({ targetId: target.targetId }).catch(() => undefined))
    );
  } finally {
    await client.close();
  }
}

async function cdpBrowserConnection(endpoint: string): Promise<{
  host: string;
  port: number;
  target?: string;
}> {
  const url = new URL(endpoint);
  if (url.protocol === "ws:" || url.protocol === "wss:") {
    return {
      host: url.hostname,
      port: Number(url.port),
      target: endpoint
    };
  }

  const versionUrl = new URL("/json/version", url);
  const response = await fetch(versionUrl);
  if (!response.ok) {
    throw new Error(`Unable to read CDP version endpoint at ${versionUrl.toString()}.`);
  }
  const version = await response.json() as { webSocketDebuggerUrl?: unknown };
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

async function resolveCdpEndpoint(): Promise<string> {
  return resolveRoxyBrowserEndpoint({
    protocol: "cdp",
    apiPort: ROXYBROWSER_API_PORT,
    apiToken: ROXYBROWSER_API_TOKEN!,
    profileName: "RoxyBrowser Chrome MCP Parity",
    profileMatch: "chrome",
    windowRemark: "chrome mcp parity",
    debugScope: "roxybrowser:mcp-parity",
    useSingleProfileFallback: false,
    createMissingProfile: true
  });
}

function assertToolSucceeded(label: string, result: CallToolResult): void {
  if (!result.isError) {
    return;
  }
  throw new Error(`${label} failed:\n${textFromResult(result)}`);
}

function textFromResult(result: CallToolResult): string {
  return (result.content ?? [])
    .filter((item): item is Extract<(typeof result.content)[number], { type: "text" }> => item.type === "text")
    .map((item) => item.text ?? "")
    .join("\n");
}

function parseJsonResultBlock(text: string): Record<string, unknown> {
  const resultIndex = text.indexOf("### Result");
  const candidate = resultIndex >= 0 ? text.slice(resultIndex + "### Result".length) : text;
  const start = candidate.indexOf("{");
  if (start < 0) {
    throw new Error(`Could not find JSON object in tool result:\n${text}`);
  }

  let depth = 0;
  let inString = false;
  let escapeNext = false;
  for (let index = start; index < candidate.length; index += 1) {
    const char = candidate[index];
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (char === "\\") {
      escapeNext = true;
      continue;
    }
    if (char === "\"") {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return JSON.parse(candidate.slice(start, index + 1)) as Record<string, unknown>;
      }
    }
  }

  throw new Error(`Could not parse complete JSON object from tool result:\n${text}`);
}

function refForButton(snapshotText: string, label: string): string {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = snapshotText.match(new RegExp(`button "${escaped}"(?: \\[[^\\]]+\\])* \\[ref=(e\\d+)\\]`));
  if (!match?.[1]) {
    throw new Error(`Unable to find ref for button "${label}" in snapshot:\n${snapshotText}`);
  }
  return match[1];
}
