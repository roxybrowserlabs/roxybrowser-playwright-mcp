import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterEach, describe, expect, it } from "vitest";
import { createRoxyBrowserMcpInMemory } from "../../src/mcp/index.js";
import { connectTestBrowserWithEndpoint } from "../helpers/browser.js";
import { TestServer } from "../helpers/testserver.js";

const cleanupCallbacks: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanupCallbacks.length) {
    await cleanupCallbacks.pop()!();
  }
});

describe("browser_run_code_unsafe MCP contract", () => {
  it("runs Playwright code against the real active page", async () => {
    const fixture = await setupRunCodeFixture(`<button onclick="console.log('Submit')">Submit</button>`);

    const response = await callTool(fixture.client, "browser_run_code_unsafe", {
      code: 'async (page) => await page.getByRole("button", { name: "Submit" }).click()'
    });

    expect(response.isError).toBeFalsy();
    expect(await consoleText(fixture.client)).toContain("[LOG] Submit");
  });

  it("runs block snippets and records generated code", async () => {
    const fixture = await setupRunCodeFixture(`<button onclick="console.log('Submit')">Submit</button>`);

    const response = await callTool(fixture.client, "browser_run_code_unsafe", {
      code: 'async (page) => { await page.getByRole("button", { name: "Submit" }).click(); await page.getByRole("button", { name: "Submit" }).click(); }'
    });

    const text = textFromResult(response);
    expect(response.isError).toBeFalsy();
    expect(text).toContain('await page.getByRole("button", { name: "Submit" }).click()');
    expect(await consoleText(fixture.client)).toMatch(/\[LOG\] Submit[\s\S]*\[LOG\] Submit/);
  });

  it("does not expose require in the VM context", async () => {
    const fixture = await setupRunCodeFixture(`<button>Submit</button>`);

    const response = await callTool(fixture.client, "browser_run_code_unsafe", {
      code: `(page) => { require('fs'); }`
    });

    expect(response.isError).toBe(true);
    expect(textFromResult(response)).toContain("ReferenceError: require is not defined");
  });

  it("returns JSON-stringified values like Playwright MCP", async () => {
    const fixture = await setupRunCodeFixture(`<button onclick="console.log('Submit')">Submit</button>`);
    const code = 'async (page) => { await page.getByRole("button", { name: "Submit" }).click(); return { message: "Hello, world!" }; await page.getByRole("banner").click(); }';

    const response = await callTool(fixture.client, "browser_run_code_unsafe", { code });
    const text = textFromResult(response);

    expect(response.isError).toBeFalsy();
    expect(text).toContain(`await (${code})(page);`);
    expect(text).toContain('{"message":"Hello, world!"}');
    expect(await consoleText(fixture.client)).toContain("[LOG] Submit");
  });

  it("keeps the server alive after route handler exceptions", async () => {
    const fixture = await setupRunCodeFixture(`<button>Submit</button>`);
    const code = `async (page) => {
      await page.unroute('**/*').catch(() => {});
      await page.route('**/route-throws.json', async (route) => {
        const path = new URL(route.request().url()).pathname;
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ path }) });
      });
      return await page.evaluate(async () => {
        const response = await fetch('/route-throws.json');
        return response.text();
      });
    }`;

    const response = await callTool(fixture.client, "browser_run_code_unsafe", { code });
    expect(response.isError).toBe(true);
    expect(textFromResult(response)).toContain("ReferenceError: URL is not defined");

    const followUp = await callTool(fixture.client, "browser_tabs", { action: "list" });
    expect(followUp.isError, textFromResult(followUp)).toBeFalsy();
  });

  it("loads code from filename", async () => {
    const fixture = await setupRunCodeFixture(`<button onclick="console.log('Clicked')">Click</button>`);
    const dir = await mkdtemp(join(tmpdir(), "roxy-run-code-e2e-"));
    cleanupCallbacks.push(async () => rm(dir, { recursive: true, force: true }));
    const filename = join(dir, "snippet.js");
    await writeFile(filename, 'async (page) => {\n  await page.getByRole("button", { name: "Click" }).click();\n}', "utf8");

    const response = await callTool(fixture.client, "browser_run_code_unsafe", {
      filename: "snippet.js",
      _meta: { cwd: dir }
    });

    expect(response.isError).toBeFalsy();
    expect(await consoleText(fixture.client)).toContain("[LOG] Clicked");
  });

  it("loads filename snippets containing template literals", async () => {
    const fixture = await setupRunCodeFixture(`<button onclick="console.log('Done')">Submit</button>`);
    const dir = await mkdtemp(join(tmpdir(), "roxy-run-code-e2e-"));
    cleanupCallbacks.push(async () => rm(dir, { recursive: true, force: true }));
    const filename = join(dir, "snippet.js");
    await writeFile(filename, 'async (page) => {\n  const title = `Page: ${await page.title()}`;\n  await page.getByRole("button", { name: "Submit" }).click();\n  return title;\n}', "utf8");

    const response = await callTool(fixture.client, "browser_run_code_unsafe", {
      filename: "snippet.js",
      _meta: { cwd: dir }
    });

    expect(response.isError).toBeFalsy();
    expect(textFromResult(response)).toContain("Page: Run Code Fixture");
    expect(await consoleText(fixture.client)).toContain("[LOG] Done");
  });

  it("can evaluate workers in the active tab and a newly selected tab", async () => {
    const fixture = await setupRunCodeFixture(`<button>Worker</button>`);
    fixture.server.setContent("/worker.js", `
      self.onmessage = (event) => self.postMessage('echo:' + event.data);
      self.workerName = 'mcp-worker';
    `, "application/javascript");
    fixture.server.setContent("/worker-page", `
      <title>WorkerPage</title>
      <script>window.__worker = new Worker('/worker.js');</script>
    `, "text/html");

    await callTool(fixture.client, "browser_navigate", { url: fixture.server.PREFIX + "/worker-page" });
    const firstResponse = await callTool(fixture.client, "browser_run_code_unsafe", {
      code: `async (page) => {
        const worker = page.workers().length ? page.workers()[0] : await page.waitForEvent('worker');
        return await worker.evaluate(() => self.workerName);
      }`
    });

    expect(firstResponse.isError, textFromResult(firstResponse)).toBeFalsy();
    expect(textFromResult(firstResponse)).toContain("mcp-worker");

    fixture.server.setContent("/worker2.js", `
      self.workerName = 'mcp-worker-2';
    `, "application/javascript");
    fixture.server.setContent("/worker-page-2", `
      <title>WorkerPage2</title>
      <script>window.__worker = new Worker('/worker2.js');</script>
    `, "text/html");

    await callTool(fixture.client, "browser_tabs", {
      action: "new",
      url: fixture.server.PREFIX + "/worker-page-2"
    });
    const secondResponse = await callTool(fixture.client, "browser_run_code_unsafe", {
      code: `async (page) => {
        const worker = page.workers().length ? page.workers()[0] : await page.waitForEvent('worker');
        return await worker.evaluate(() => self.workerName);
      }`
    });

    expect(secondResponse.isError, textFromResult(secondResponse)).toBeFalsy();
    expect(textFromResult(secondResponse)).toContain("mcp-worker-2");
  });

  it("can wait for a current page crash without duplicating tabs", async () => {
    const fixture = await setupRunCodeFixture(`<h1>Crash</h1>`);

    const response = await callTool(fixture.client, "browser_run_code_unsafe", {
      code: `async page => {
        await Promise.all([
          page.waitForEvent('crash'),
          page.goto('chrome://crash').catch(() => {}),
        ]);
      }`
    });

    expect(response.isError, textFromResult(response)).toBeFalsy();
    const tabs = await callTool(fixture.client, "browser_tabs", { action: "list" });
    expect(tabs.isError, textFromResult(tabs)).toBeFalsy();
    expect(textFromResult(tabs)).toContain("- 0: (current) [(untitled)](about:blank)");
  });

  it("can wait for a non-current page crash created by run-code", async () => {
    const fixture = await setupRunCodeFixture(`<h1>Crash</h1>`);

    const response = await callTool(fixture.client, "browser_run_code_unsafe", {
      code: `async page => {
        const otherPage = await page.context().newPage();
        await Promise.all([
          otherPage.waitForEvent('crash'),
          otherPage.goto('chrome://crash').catch(() => {}),
        ]);
      }`
    });

    expect(response.isError, textFromResult(response)).toBeFalsy();
    const tabs = await callTool(fixture.client, "browser_tabs", { action: "list" });
    expect(tabs.isError, textFromResult(tabs)).toBeFalsy();
    expect(textFromResult(tabs).match(/^- /gm)).toHaveLength(2);
    expect(textFromResult(tabs)).toContain("[(untitled)](about:blank) [crashed]");
  });
});

async function setupRunCodeFixture(body: string) {
  const assetRoot = await mkdtemp(join(tmpdir(), "roxy-run-code-assets-"));
  cleanupCallbacks.push(async () => rm(assetRoot, { recursive: true, force: true }));
  const server = await TestServer.create(assetRoot);
  cleanupCallbacks.push(async () => server.stop());
  server.setContent("/", `<html><head><title>Run Code Fixture</title></head><body>${body}</body></html>`, "text/html");

  const { browser, endpoint } = await connectTestBrowserWithEndpoint();
  cleanupCallbacks.push(async () => browser.close().catch(() => {}));

  const bundle = await createRoxyBrowserMcpInMemory({ snapshotMode: "none" });
  cleanupCallbacks.push(async () => bundle.close());
  const client = new Client({ name: "run-code-e2e", version: "1.0.0" });
  cleanupCallbacks.push(async () => client.close());
  await client.connect(bundle.clientTransport);
  await callTool(client, "roxy_browser_connect", { endpoint });
  await callTool(client, "browser_navigate", { url: server.PREFIX });
  return { client, server };
}

async function consoleText(client: Client): Promise<string> {
  return textFromResult(await callTool(client, "browser_console_messages", { onlyErrors: false }));
}

async function callTool(client: Client, name: string, args: Record<string, unknown> = {}) {
  const { _meta, ...toolArgs } = args;
  return await client.callTool({
    name,
    arguments: toolArgs,
    ...(_meta && typeof _meta === "object" ? { _meta: _meta as Record<string, unknown> } : {})
  });
}

function textFromResult(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content
    .filter((item) => item.type === "text")
    .map((item) => item.text ?? "")
    .join("\n");
}
