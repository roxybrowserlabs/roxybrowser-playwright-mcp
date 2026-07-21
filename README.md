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

## Browser connect

RoxyBrowser uses `browserType.connect(endpointURL)` as the only browser entry point. `launch()` and `connectOverCDP()` are intentionally unsupported and throw migration errors that point callers to `connect()`.

`chromium.connect()` attaches to a Chromium/CDP WebSocket endpoint such as `ws://127.0.0.1:9222/devtools/browser/<id>`.

`firefox.connect()` attaches to a Firefox/WebDriver BiDi WebSocket endpoint. The Firefox BiDi path supports context creation, page creation, navigation, title lookup, script evaluation, and locator-based `click`, `hover`, `fill`, `type`, `press`, `textContent`, and `isVisible` flows.

- `ws://` and `wss://` endpoints are supported.
- `launch()` is not supported by the public Roxy API.
- `connectOverCDP()` is not supported by the public Roxy API; use `connect()` for CDP and BiDi.

## Examples

The [`examples`](./examples) directory contains runnable `.mjs` scripts grouped by entry point. Prefer the shared runner so endpoint environment variables are loaded and injected consistently:

- `pnpm examples page connect-over-cdp`
  Connects to an existing CDP WebSocket endpoint from `ROXY_CDP_ENDPOINT` with `chromium.connect()` and runs the same flow.
- `pnpm examples page verify-baidu-search`
  Drives Baidu search through the Page API and types into the search box with `page.type(...)`.
- `pnpm examples page page-events-and-screenshot`
  Connects to an endpoint, starts a temporary HTTP fixture, logs `page.on(...)` events, removes a `request` listener, and writes a screenshot to a temporary file.
- `pnpm examples page connect-firefox-bidi`
  Exercises the Firefox WebDriver BiDi backend by connecting to an existing BiDi websocket.
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
- `ROXY_PLAYWRIGHT_ARTIFACTS_DIR=/absolute/path/to/artifacts`
- `ROXY_PLAYWRIGHT_DOWNLOADS_DIR=/absolute/path/to/downloads`
- `ROXY_PLAYWRIGHT_TEMP_DIR=/absolute/path/to/temp`

## Connecting the MCP server to a browser

Before other MCP tools can act on a page, attach the session to a running browser with the `roxy_browser_connect` tool:

- `endpoint` (required): the CDP WebSocket endpoint (Chrome) or the BiDi websocket endpoint (Firefox).
- `browser`: `chrome` (default) or `firefox`. Chrome connects over CDP; Firefox connects over WebDriver BiDi.
- `sessionId` (optional): reuse an existing BiDi session.

Endpoints typically come from the RoxyBrowser desktop app's local API, which opens a profile and returns a debugging endpoint. Once connected, the standard `browser_*` tools (`browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_take_screenshot`, and so on) operate on the active tab.

### In-memory launch-and-connect

`roxy_browser_launch` is a special convenience tool for `createRoxyBrowserMcpInMemory()` only. The stdio and HTTP MCP servers keep exposing `roxy_browser_connect` and do not register `roxy_browser_launch` by default.

Enable it by passing RoxyBrowser launch configuration when creating the in-memory server:

```ts
import { createRoxyBrowserMcpInMemory } from "@roxybrowser/playwright/mcp";

const bundle = await createRoxyBrowserMcpInMemory({
  roxyBrowserLaunch: {
    workspaceId: 123,
    apiToken: process.env.ROXYBROWSER_API_TOKEN!,
    apiPort: process.env.ROXYBROWSER_API_PORT ?? 50000
  }
});
```

The tool input is intentionally small:

- `dirId` (required): the RoxyBrowser profile/window directory ID.
- `browser`: `chrome` (default) or `firefox`.
- `forceOpen`: passed to the RoxyBrowser open call when the profile is not already open.
- `args`: optional browser startup arguments.

Before opening anything, `roxy_browser_launch` calls the RoxyBrowser connection-info API for that `dirId`. If an endpoint is already available, it connects directly. Otherwise it opens the profile and then connects. On success, it returns structured JSON in `structuredContent` and the same JSON as text:

```json
{
  "browsers": [
    {
      "dirId": "profile-dir-id",
      "endpoint": "ws://127.0.0.1:9222/devtools/browser/...",
      "connected": true,
      "pageUrl": "https://example.com/",
      "browserType": "chrome"
    }
  ]
}
```

## Asset directories

Page API and MCP tools share one asset model. Screenshots, downloads, snapshots,
traces, videos, network exports, console exports, script outputs, and temporary
runtime files are resolved by the same asset manager.

API options take precedence over environment variables. Relative `filename`
arguments are resolved inside the relevant asset directory. Absolute asset paths
are rejected by default.

Supported environment variables:

- `ROXY_PLAYWRIGHT_ARTIFACTS_DIR`: default durable asset root.
- `ROXY_PLAYWRIGHT_DOWNLOADS_DIR`: browser downloads.
- `ROXY_PLAYWRIGHT_SCREENSHOTS_DIR`: screenshots.
- `ROXY_PLAYWRIGHT_SNAPSHOTS_DIR`: accessibility snapshots and snapshot markdown files.
- `ROXY_PLAYWRIGHT_TRACES_DIR`: traces.
- `ROXY_PLAYWRIGHT_VIDEOS_DIR`: videos and screencast recordings.
- `ROXY_PLAYWRIGHT_NETWORK_DIR`: network exports.
- `ROXY_PLAYWRIGHT_CONSOLE_DIR`: console exports.
- `ROXY_PLAYWRIGHT_SCRIPTS_DIR`: script and evaluate outputs.
- `ROXY_PLAYWRIGHT_TEMP_DIR`: short-lived runtime files.
- `SANDBOX_OUTPUT_DIR`: agent sandbox output directory. When set and no API asset option is provided, it becomes the default artifacts/downloads/scripts root.

The old MCP-specific variables `ROXY_MCP_OUTPUT_DIR`,
`PLAYWRIGHT_MCP_OUTPUT_DIR`, `ROXY_MCP_TEMP_DIR`, and
`PLAYWRIGHT_MCP_TEMP_DIR` are not supported.

You can also set asset directories directly when creating the MCP server or transports:

```ts
import {
  createRoxyBrowserMcpInMemory,
  createRoxyBrowserMcpServer,
  startRoxyBrowserMcpHttp,
  startRoxyBrowserMcpStdio
} from "@roxybrowser/playwright/mcp";

const artifactsDir = "/absolute/path/to/artifacts";
const downloadsDir = "/absolute/path/to/downloads";
const screenshotsDir = "/absolute/path/to/screenshots";
const snapshotsDir = "/absolute/path/to/snapshots";
const tempDir = "/absolute/path/to/temp";

createRoxyBrowserMcpServer({
  artifactsDir,
  downloadsDir,
  screenshotsDir,
  snapshotsDir,
  tempDir
});

await createRoxyBrowserMcpInMemory({
  artifactsDir,
  downloadsDir,
  screenshotsDir,
  snapshotsDir,
  tempDir
});

await startRoxyBrowserMcpHttp({
  port: 3000,
  artifactsDir,
  downloadsDir,
  screenshotsDir,
  snapshotsDir,
  tempDir
});

await startRoxyBrowserMcpStdio({
  artifactsDir,
  downloadsDir,
  screenshotsDir,
  snapshotsDir,
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

- `--artifacts-dir /absolute/path`
- `--downloads-dir /absolute/path`
- `--screenshots-dir /absolute/path`
- `--snapshots-dir /absolute/path`
- `--traces-dir /absolute/path`
- `--videos-dir /absolute/path`
- `--network-dir /absolute/path`
- `--console-dir /absolute/path`
- `--scripts-dir /absolute/path`
- `--temp-dir /absolute/path`
- `--snapshot-mode full`
- `--snapshot-mode none`

Note: in the currently installed inspector version, the `mcp-inspector` CLI wrapper itself has a local dependency compatibility issue in this workspace, so the reliable path here is the inspector UI flow above via `client/bin/start.js`.
