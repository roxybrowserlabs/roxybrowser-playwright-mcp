# @roxybrowser/playwright

`@roxybrowser/playwright` is a Playwright-style browser-automation library with **humanized behavior by default**, plus an MCP server (`@roxybrowser/playwright/mcp`) that exposes the same capabilities as tools. It targets Chromium over CDP and Firefox over WebDriver BiDi. It is not a fork of Playwright — it reproduces a Playwright-familiar public API on top of a protocol-agnostic adapter layer.

## Design goals

- Keep the public API familiar to Playwright users.
- Route all browser operations through a protocol-agnostic adapter layer.
- Support both CDP (Chromium) and WebDriver BiDi (Firefox) as protocol backends.
- Make click, type, hover, and scroll behavior humanized by default instead of adding a second API.
- Expose the same capabilities as MCP tools for agent-driven automation.

## Install

```bash
npm install @roxybrowser/playwright
# or
pnpm add @roxybrowser/playwright
```

The package is ESM-only (`"type": "module"`, `NodeNext` resolution). Two entry points are published:

- `@roxybrowser/playwright` — the Playwright-style library (`chromium`, `firefox`, `Browser`, `BrowserContext`, `Page`, `Locator`, `ElementHandle`).
- `@roxybrowser/playwright/mcp` — the MCP server factories and transports.

## Package layout

- `src/browser*.ts`: public browser, context, and browser type objects.
- `src/page.ts` and `src/locator.ts`: Playwright-style page and locator APIs.
- `src/protocol/*`: protocol abstraction plus CDP and BiDi backend entry points.
- `src/human/*`: humanization profiles and controller contracts.
- `src/mcp/*`: the MCP server, runtime, connected-browser session, and tools.
- `CLAUDE.md` / `AGENTS.md`: architecture notes and repository guidance.

## Testing

- `pnpm test` runs the unit suite in `tests/unit`.
- `pnpm test:e2e` runs a real-browser CDP flow in `tests/e2e`.
- `pnpm test:e2e:bidi` runs the Firefox BiDi e2e suite in `tests/e2e/bidi`.

The e2e suite writes a temporary HTML fixture, launches Chrome or Edge in headless mode, and verifies the public API against a real page through CDP. If auto-detection is not enough for your machine or CI image, set `ROXY_E2E_EXECUTABLE_PATH` to a Chromium-based browser binary before running the e2e command.

The BiDi e2e suite prefers connecting to an existing Firefox BiDi websocket when `ROXY_BIDI_WS_ENDPOINT` is set. Without that variable, it launches a local Firefox binary with a temporary test profile and will use `ROXY_BIDI_EXECUTABLE_PATH` when provided. Set `ROXY_BIDI_USE_ROXYBROWSER_API=1` to opt into opening a Firefox profile through the RoxyBrowser local API; the helper closes the connected browser/profile after each test by default so repeated local runs do not leak Firefox windows. Set `ROXY_BIDI_KEEP_BROWSER_OPEN=1` only when deliberately debugging a shared endpoint and you intentionally want the Firefox window to stay open after a test. See `.env.example` for the supported local settings.

## Browser launch

`chromium.launch()` uses a locally installed Chromium-family browser. Launch resolution order is:

- `executablePath`: use an explicit browser binary.
- `channel`: resolve a known local install such as `chrome`, `chrome-beta`, `chrome-dev`, `chrome-canary`, `msedge`, `msedge-beta`, `msedge-dev`, `msedge-canary`, or `chromium`.
- auto-detection: fall back to the default Chrome, Chromium, and Edge candidate paths for the current platform.

`firefox.launch()` uses the WebDriver BiDi backend by default and launches a locally installed Firefox binary directly. The Firefox BiDi path supports browser launch, context creation, page creation, navigation, title lookup, script evaluation, and locator-based `click`, `hover`, `fill`, `type`, `press`, `textContent`, and `isVisible` flows.

Firefox launch requires a local Firefox binary with BiDi remote debugging support. If auto-detection is not enough for your machine or CI image, set `ROXY_EXECUTABLE_PATH` or pass `executablePath` explicitly.

## CDP connect

`chromium.connectOverCDP()` currently supports direct WebSocket DevTools endpoints such as `ws://127.0.0.1:9222/devtools/browser/<id>`.

- `ws://` and `wss://` endpoints are supported.
- `http://` discovery endpoints are not supported yet.
- custom `headers` are not supported for WebSocket endpoints yet.

## Examples

The [`examples`](./examples) directory contains runnable `.mjs` scripts grouped by entry point. Run them directly with Node:

- `node examples/page/launch-local-browser.mjs`
  Launches a locally installed browser, opens a temporary `file://` fixture, and prints the result.
- `pnpm examples page connect-over-cdp`
  Connects to an existing CDP WebSocket endpoint from `ROXY_CDP_ENDPOINT` and runs the same flow.
- `pnpm examples page verify-baidu-search`
  Drives Baidu search through the Page API and types into the search box with `page.type(...)`.
- `node examples/page/page-events-and-screenshot.mjs`
  Launches a local browser, starts a temporary HTTP fixture, logs `page.on(...)` events, removes a `request` listener, and writes a screenshot to a temporary file.
- `node examples/page/launch-firefox-bidi.mjs` / `node examples/page/connect-firefox-bidi.mjs`
  Exercise the Firefox WebDriver BiDi backend by launching a local Firefox binary or connecting to an existing BiDi websocket.
- `pnpm examples mcp verify-baidu-search`
  Drive the MCP server end-to-end (Baidu search, drag, file upload, humanized typing) and double as integration checks.

Use `examples/page/` for direct Browser/Context/Page API examples, `examples/mcp/` for MCP tool examples, and `examples/repro/` for bug reproductions.
Use `pnpm examples <module> <script>` to run a script through the shared examples runner. The runner loads `.env`, injects `ROXY_CDP_ENDPOINT` / `ROXY_BIDI_ENDPOINT`, and can open a RoxyBrowser profile through the local API when an endpoint is missing.

Useful environment variables:

- `ROXY_BROWSER_CHANNEL=chrome|msedge|chromium`
- `ROXY_BROWSER_NAME=chromium|firefox`
- `ROXY_EXECUTABLE_PATH=/absolute/path/to/browser`
- `ROXY_HEADLESS=false`
- `ROXY_CDP_ENDPOINT=ws://127.0.0.1:9222/devtools/browser/<id>`
- `ROXY_BIDI_ENDPOINT=ws://127.0.0.1:9222/session/<id>`
- `ROXY_MCP_OUTPUT_DIR=/absolute/path/to/output`
- `ROXY_MCP_TEMP_DIR=/absolute/path/to/temp`

## Connecting the MCP server to a browser

Before other MCP tools can act on a page, attach the session to a running browser with the `roxy_browser_connect` tool:

- `endpoint` (required): the CDP WebSocket endpoint (Chrome) or the BiDi websocket endpoint (Firefox).
- `browser`: `chrome` (default) or `firefox`. Chrome connects over CDP; Firefox connects over WebDriver BiDi.
- `sessionId` (optional): reuse an existing BiDi session.

Endpoints typically come from the RoxyBrowser desktop app's local API, which opens a profile and returns a debugging endpoint. Once connected, the standard `browser_*` tools (`browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_take_screenshot`, and so on) operate on the active tab.

## MCP output directory

The MCP tools that produce durable output files, such as `browser_take_screenshot`,
`browser_network_requests`, `browser_network_request`, `browser_console_messages`,
and `browser_evaluate`, support a shared output directory.

- Set `ROXY_MCP_OUTPUT_DIR` to choose the default directory for MCP-generated files.
- `PLAYWRIGHT_MCP_OUTPUT_DIR` is also recognized for compatibility with Playwright MCP.
- If a tool receives a relative `filename`, it will be resolved inside the output directory.
- If a tool receives an absolute `filename`, it will be used as-is.
- If no output directory is configured, the default is `.roxybrowser-playwright-mcp` under the current working directory, or the system temp directory when the cwd is not writable.

## MCP temp directory

Some MCP runtime files are intentionally kept separate from `outputDir`.
These are short-lived files created during automation, such as:

- `browser_snapshot` files saved with `filename`
- browser console event log files referenced from snapshots

Temp directory behavior:

- Set `ROXY_MCP_TEMP_DIR` to choose the default directory for MCP runtime temp files.
- `PLAYWRIGHT_MCP_TEMP_DIR` is also recognized for compatibility with Playwright MCP.
- If a tool receives a relative `filename`, it will be resolved inside the temp directory.
- If a tool receives an absolute `filename`, it will be used as-is.
- If no temp directory is configured, the default is the system temp directory from Node.js `os.tmpdir()`.

You can also set `outputDir` and `tempDir` directly when creating the MCP server or transports:

```ts
import {
  createRoxyBrowserMcpInMemory,
  createRoxyBrowserMcpServer,
  startRoxyBrowserMcpHttp,
  startRoxyBrowserMcpStdio
} from "@roxybrowser/playwright/mcp";

const outputDir = "/absolute/path/to/output";
const tempDir = "/absolute/path/to/temp";

createRoxyBrowserMcpServer({
  outputDir,
  tempDir
});

await createRoxyBrowserMcpInMemory({
  outputDir,
  tempDir
});

await startRoxyBrowserMcpHttp({
  port: 3000,
  outputDir,
  tempDir
});

await startRoxyBrowserMcpStdio({
  outputDir,
  tempDir
});
```

## MCP inspector workflow

This repo includes [`@modelcontextprotocol/inspector`](https://github.com/modelcontextprotocol/inspector) as a dev dependency so we can debug the Playwright MCP server locally.

### Local stdio inspector

Use the inspector to spawn the built MCP server over `stdio`:

```bash
pnpm inspector
```

That command will:

- build the TypeScript sources into `dist/`
- start the MCP Inspector UI on `http://127.0.0.1:6274`
- launch `node ./dist/bin/roxybrowser-mcp.js` as the inspected MCP server

This is the fastest loop when you want to manually exercise tools from the inspector UI.

### Local HTTP inspector

If you want to keep the MCP server running separately and connect the inspector over Streamable HTTP:

Terminal 1:

```bash
pnpm mcp:http
```

Terminal 2:

```bash
pnpm inspector:http
```

By default the HTTP server listens on `http://127.0.0.1:3333/mcp`.

### MCP server CLI options

The bundled `roxybrowser-mcp` launcher supports both transports:

```bash
node ./dist/bin/roxybrowser-mcp.js --transport stdio
node ./dist/bin/roxybrowser-mcp.js --transport http --port 3333 --host 127.0.0.1 --path /mcp
```

Optional flags:

- `--output-dir /absolute/path`
- `--temp-dir /absolute/path`
- `--snapshot-mode full`
- `--snapshot-mode none`

Note: in the currently installed inspector version, the `mcp-inspector` CLI wrapper itself has a local dependency compatibility issue in this workspace, so the reliable path here is the inspector UI flow above via `client/bin/start.js`.
