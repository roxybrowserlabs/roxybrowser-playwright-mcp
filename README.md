# @roxybrowser/playwright

`@roxybrowser/playwright` is a Playwright-style automation library with humanized behavior by default.

## Design goals

- Keep the public API familiar to Playwright users.
- Route all browser operations through a protocol-agnostic adapter layer.
- Start with `chrome-remote-interface` over CDP.
- Reserve clean extension points for future BiDi and WebDriver backends.
- Make click, type, hover, and scroll behavior humanized by default instead of adding a second API.

## Package layout

- `src/browser*.ts`: public browser, context, and browser type objects.
- `src/page.ts` and `src/locator.ts`: Playwright-style page and locator APIs.
- `src/protocol/*`: protocol abstraction plus CDP and BiDi backend entry points.
- `src/protocol/webdriver-classic/*`: classic WebDriver bootstrap placeholder kept separate from the BiDi backend's third-party `webdriver` package dependency.
- `src/human/*`: humanization profiles and controller contracts.
- `docs/architecture.md`: detailed architecture notes and implementation plan.

## Current state

This branch establishes the package scaffold, API shape, and protocol boundaries. The CDP runtime is intentionally skeletal so the architecture can be reviewed before we lock implementation details.

## Testing

- `pnpm test` runs the unit suite in `tests/unit`.
- `pnpm test:e2e` runs a real-browser CDP flow in `tests/e2e`.

The e2e suite writes a temporary HTML fixture, launches Chrome or Edge in headless mode, and verifies the public API against a real page through CDP. If auto-detection is not enough for your machine or CI image, set `ROXY_E2E_EXECUTABLE_PATH` to a Chromium-based browser binary before running the e2e command.

## Browser launch

`chromium.launch()` uses a locally installed Chromium-family browser. Launch resolution order is:

- `executablePath`: use an explicit browser binary.
- `channel`: resolve a known local install such as `chrome`, `chrome-beta`, `chrome-dev`, `chrome-canary`, `msedge`, `msedge-beta`, `msedge-dev`, `msedge-canary`, or `chromium`.
- auto-detection: fall back to the default Chrome, Chromium, and Edge candidate paths for the current platform.

`firefox.launch()` now uses the BiDi backend by default through the `webdriver` package and launches a locally installed Firefox binary. The current Firefox BiDi path supports browser launch, context creation, page creation, navigation, title lookup, script evaluation, and locator-based `click`, `hover`, `fill`, `type`, `press`, `textContent`, and `isVisible` flows.

Firefox launch also depends on a working geckodriver runtime. If your package manager blocks dependency postinstall scripts, you may need to approve the geckodriver install step or provide your own driver binary in the environment.

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

Useful environment variables:

- `ROXY_BROWSER_CHANNEL=chrome|msedge|chromium`
- `ROXY_BROWSER_NAME=chromium|firefox`
- `ROXY_EXECUTABLE_PATH=/absolute/path/to/browser`
- `ROXY_HEADLESS=false`
- `ROXY_CDP_WS_ENDPOINT=ws://127.0.0.1:9222/devtools/browser/<id>`
