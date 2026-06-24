# @roxybrowser/playwright

`@roxybrowser/playwright` is a Playwright-style automation library with humanized behavior by default.

## Design goals

- Keep the public API familiar to Playwright users.
- Route all browser operations through a protocol-agnostic adapter layer.
- Start with `chrome-remote-interface` over CDP.
- Keep CDP and BiDi as the supported protocol backends.
- Make click, type, hover, and scroll behavior humanized by default instead of adding a second API.

## Package layout

- `src/browser*.ts`: public browser, context, and browser type objects.
- `src/page.ts` and `src/locator.ts`: Playwright-style page and locator APIs.
- `src/protocol/*`: protocol abstraction plus CDP and BiDi backend entry points.
- `src/human/*`: humanization profiles and controller contracts.
- `docs/architecture.md`: detailed architecture notes and implementation plan.

## Current state

This branch establishes the package scaffold, API shape, and protocol boundaries. The CDP runtime is intentionally skeletal so the architecture can be reviewed before we lock implementation details.

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

`firefox.launch()` now uses the BiDi backend by default and launches a locally installed Firefox binary directly. The current Firefox BiDi path supports browser launch, context creation, page creation, navigation, title lookup, script evaluation, and locator-based `click`, `hover`, `fill`, `type`, `press`, `textContent`, and `isVisible` flows.

Firefox launch requires a local Firefox binary with BiDi remote debugging support. If auto-detection is not enough for your machine or CI image, set `ROXY_EXECUTABLE_PATH` or pass `executablePath` explicitly.

## CDP connect

`chromium.connectOverCDP()` currently supports direct WebSocket DevTools endpoints such as `ws://127.0.0.1:9222/devtools/browser/<id>`.

- `ws://` and `wss://` endpoints are supported.
- `http://` discovery endpoints are not supported yet.
- custom `headers` are not supported for WebSocket endpoints yet.

## Examples

The [`examples`](/Users/macos/code/roxy-company/roxybrowser-playwright-mcp/examples) directory contains runnable scripts that import the package by its published name, `@roxybrowser/playwright`.

- `pnpm example:launch`
  Launches a locally installed browser, opens a temporary `file://` fixture, and prints the result.
- `pnpm example:connect-cdp`
  Connects to an existing CDP WebSocket endpoint from `ROXY_CDP_WS_ENDPOINT` and runs the same flow.
- `pnpm example:page-events`
  Launches a local browser, starts a temporary HTTP fixture, logs `page.on(...)` events, removes a `request` listener, and writes a screenshot to a temporary file.

Useful environment variables:

- `ROXY_BROWSER_CHANNEL=chrome|msedge|chromium`
- `ROXY_BROWSER_NAME=chromium|firefox`
- `ROXY_EXECUTABLE_PATH=/absolute/path/to/browser`
- `ROXY_HEADLESS=false`
- `ROXY_CDP_WS_ENDPOINT=ws://127.0.0.1:9222/devtools/browser/<id>`
- `ROXY_MCP_OUTPUT_DIR=/absolute/path/to/output`

## MCP output directory

The MCP tools that save files, such as `browser_snapshot`, `browser_take_screenshot`,
`browser_network_requests`, `browser_network_request`, `browser_console_messages`,
and `browser_evaluate`, support a shared output directory.

- Set `ROXY_MCP_OUTPUT_DIR` to choose the default directory for MCP-generated files.
- `PLAYWRIGHT_MCP_OUTPUT_DIR` is also recognized for compatibility with Playwright MCP.
- If a tool receives a relative `filename`, it will be resolved inside the output directory.
- If a tool receives an absolute `filename`, it will be used as-is.
- If no output directory is configured, the default is `.roxybrowser-mcp` under the current working directory, or the system temp directory when the cwd is not writable.

You can also set `outputDir` directly when creating the MCP server or transports:

```ts
import {
  createRoxyBrowserMcpInMemory,
  createRoxyBrowserMcpServer,
  startRoxyBrowserMcpHttp,
  startRoxyBrowserMcpStdio
} from "@roxybrowser/playwright/mcp";

const outputDir = "/absolute/path/to/output";

createRoxyBrowserMcpServer({
  outputDir
});

await createRoxyBrowserMcpInMemory({
  outputDir
});

await startRoxyBrowserMcpHttp({
  port: 3000,
  outputDir
});

await startRoxyBrowserMcpStdio({
  outputDir
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
- `--snapshot-mode full`
- `--snapshot-mode none`

Note: in the currently installed inspector version, the `mcp-inspector` CLI wrapper itself has a local dependency compatibility issue in this workspace, so the reliable path here is the inspector UI flow above via `client/bin/start.js`.
