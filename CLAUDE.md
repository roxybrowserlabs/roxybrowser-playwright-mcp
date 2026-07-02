# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`@roxybrowser/playwright` is a Playwright-style browser-automation library with **humanized behavior by default**, plus an MCP server (`@roxybrowser/playwright/mcp`) that exposes the same capabilities as tools. It targets Chromium over CDP and Firefox over WebDriver BiDi. It is NOT a fork of Playwright — it reproduces a Playwright-familiar public API on top of a protocol-agnostic adapter layer.

Package manager is **pnpm**. The package is ESM-only (`"type": "module"`, `NodeNext` module resolution). All internal imports use explicit `.js` extensions even though sources are `.ts`.

## Guiding principles (highest priority)

These two goals rank above everything else and every interaction-related change is judged against them:

1. **Playwright API semantics first.** Signatures, behavior, return values, and event order align with upstream Playwright so users don't have to relearn anything.
2. **Humanization-first.** Every interaction (click / hover / type / scroll / drag) is humanized *by default* through `HumanController` — human-like, never mechanical. This is the headline feature, not an opt-in.

**When these conflict, or a change otherwise breaks something, you MUST leave a trace — never diverge silently:**

- **Humanization breaks Playwright semantics** (timing, event sequence, return timing, etc.) → add a code comment explaining *why* this deviates and that it's a humanization trade-off. Reuse the existing `⚠️ DIVERGENCE FROM PLAYWRIGHT` comment style for consistency.
- **CDP / BiDi parity.** The target is identical behavior across the CDP (chromium) and BiDi (firefox) backends. When BiDi genuinely cannot match CDP, you MUST both (1) add a code comment explaining the difference and its root cause (protocol/engine limitation), **and** (2) leave a reproducible example under `examples/` (same style as the `verify-*.mjs` scripts / e2e tests).

Silent divergence — from Playwright semantics *or* from CDP↔BiDi parity — is not acceptable. Comment it, and for cross-protocol gaps ship a repro example.

## Commands

```bash
pnpm build                 # tsc -> dist/  (required before running the MCP server or parity tests)
pnpm typecheck             # tsc --noEmit
pnpm test                  # unit suite (tests/unit)
pnpm test:unit             # same, explicit config
pnpm test:e2e              # real-browser CDP e2e (tests/e2e, excludes bidi)
pnpm test:e2e:bidi         # Firefox BiDi e2e (loads .env)
pnpm test:mcp-parity       # builds bundle, then compares this MCP vs @playwright/mcp against a shared RoxyBrowser profile
pnpm test:unit:bundle      # builds bundle, runs unit tests against the bundled output
pnpm test:coverage         # unit suite with v8 coverage

# Run a single test file / test name:
pnpm vitest run tests/unit/locator.test.ts
pnpm vitest run -t "clicks with jitter"

# MCP server (builds first):
pnpm mcp:stdio             # stdio transport
pnpm mcp:http               # streamable HTTP on 127.0.0.1:3333/mcp
pnpm inspector              # MCP Inspector UI + stdio server (fastest manual tool-exercise loop)
pnpm inspector:http         # inspector against a separately-run `pnpm mcp:http`

# Vendored Playwright snapshot source regen (rarely needed):
pnpm build:vendor:snapshot
pnpm build:bundle           # vite -> dist/roxybrowser.bundle.js (used by parity + bundle tests)
```

The unit config enforces **90% line/function/branch/statement coverage** thresholds on `src/**` (with `src/types/**`, the protocol backends, and adapter/capabilities files excluded from coverage). Don't lower the threshold to make CI pass — add tests.

E2e tests run serially (`fileParallelism: false`, `maxWorkers: 1`) and have a global setup that force-cleans stray browser processes. Set `ROXY_E2E_EXECUTABLE_PATH` (Chromium e2e) or `ROXY_BIDI_EXECUTABLE_PATH` / `ROXY_BIDI_WS_ENDPOINT` (BiDi) when auto-detection fails. See `.env.example` for the full set.

## Architecture

### Two surfaces, one runtime

1. **Playwright-style library** (`src/index.ts`): exports `chromium` / `firefox` browser types and `Browser`, `BrowserContext`, `Page`, `Locator`, `ElementHandle`. Public type surface lives in `src/types/{api,events,options}.ts`.
2. **MCP server** (`src/mcp/index.ts`): `createRoxyBrowserMcpServer` / `createRoxyBrowserMcpInMemory` / `startRoxyBrowserMcpStdio` / `startRoxyBrowserMcpHttp`. The same underlying `McpRuntime` + `ConnectedBrowserSession` powers both surfaces.

### Protocol-agnostic adapter with two backends

- `src/protocol/adapter.ts` — the `ProtocolBrowserAdapter` interface and `LocatorStrategy` types that the Page/Locator/Frame code programs against. **Never import CDP or BiDi types from `page.ts`/`locator.ts`/`frame.ts`** — go through the adapter.
- `src/protocol/cdp/backend.ts` — CDP backend (chromium), uses `chrome-remote-interface`.
- `src/protocol/bidi/{backend,client}.ts` — WebDriver BiDi backend (firefox).
- `src/browserType.ts` — `RoxyBrowserType` dispatches to the right adapter factory per `browserName` + `protocol`. Default protocol: chromium→cdp, firefox→bidi.

**Deliberate divergence from Playwright — do not "fix":** `BrowserType.connect()` dispatches on `browserName` (chromium→CDP, firefox→BiDi) instead of being CDP-only. `connectOverCDP()` remains chromium/CDP-only by design. There are explicit `⚠️ DIVERGENCE FROM PLAYWRIGHT` comments marking these; respect them.

### Humanization (the headline feature)

`src/human/` — `HumanController` interface + `DefaultHumanController` implementation. Click, hover, type, and scroll are humanized *by default* through the controller (jittered mouse movement via `bubbleCursor.ts`, profile-driven delays) rather than via a separate API. Three named profiles — `cautious`, `balanced`, `fast` — live in `human/profile.ts` and are resolved through `resolveHumanizationOptions`. `McpRuntime` applies these to tool-driven interactions.

### MCP tool registration

`src/mcp/server.ts` merges **two tool systems** into one MCP server:

- **Backend tools** (`src/mcp/backend/*.ts`, exported via `tools.ts`): the newer, capability-tagged, grouped-by-domain tools (`navigate`, `network`, `snapshot`, `screenshot`, `evaluate`, `files`, `keyboard`, `dialogs`, `console`, `tabs`, `connect`, `common`, `runCode`). Each file default-exports a `Tool[]`. Tool names are the `browser_*` identifiers clients see (e.g. `browser_navigate`, `browser_snapshot`, `browser_click`).
- **Legacy tools** (`src/mcp/tools/{mouse,form}.ts` via `tool.ts`): older shape, kept for tools not yet migrated.

Backend tools take precedence by name — `server.ts` filters legacy tools whose names collide with backend tools. When adding or migrating a tool, prefer the backend shape and register it in `backend/tools.ts`.

`McpRuntime` (`src/mcp/runtime.ts`) owns session state, snapshot/ref resolution, and the humanization profile. `ConnectedBrowserSession` (`src/mcp/connectedBrowser.ts`) is the large class that actually talks CDP/BiDi — connection, snapshots, input, network/console capture, file upload, drag. It contains both `CdpConnectedBrowserSession` and `BidiConnectedBrowserSession`.

### Vendored Playwright source

The full upstream Playwright source lives at `library/playwright/` (a git submodule pointing at microsoft/playwright). **When you need to read Playwright source — to match a behavior, check an upstream signature, or understand the injected scripts — read from `library/playwright/`, never from `node_modules/`.** The `node_modules` copy is the published/compiled artifact and is not authoritative for this repo's purposes.

`library/playwright/` `src/vendor/playwright/source/` mirrors the Playwright files we depend on (notably `injected/injectedScript.snapshot.ts`) and is **excluded from `tsconfig.json`**. `scripts/generate-playwright-snapshot-source.mjs` bundles that entry with vite into `src/vendor/playwright/generated/injectedScriptSource.ts` (the aria-snapshot injected script). Regenerate via `pnpm build:vendor:snapshot` only when the vendored source changes; the generated file is checked in.

### Output and temp directories

MCP tools that write durable files (screenshots, network/console dumps, evaluate output) honor `outputDir`; short-lived runtime files (snapshots saved with `filename`, console logs referenced by snapshots) honor `tempDir`. Resolution (`src/mcp/output.ts`): env `ROXY_MCP_OUTPUT_DIR` / `PLAYWRIGHT_MCP_OUTPUT_DIR` (default `.roxybrowser-playwright-mcp` under cwd, or `os.tmpdir()` if cwd unwritable) and `ROXY_MCP_TEMP_DIR` / `PLAYWRIGHT_MCP_TEMP_DIR` (default `os.tmpdir()`). Relative `filename` args resolve inside the dir; absolute paths pass through. Both default dirs are gitignored.

### RoxyBrowser local API

Some flows (Firefox BiDi e2e, MCP parity tests) open profiles through the RoxyBrowser desktop app's local API via `ROXYBROWSER_API_PORT` + `ROXYBROWSER_API_TOKEN`. When set, the BiDi e2e suite can open a Firefox profile through that API instead of launching a bare Firefox binary (`ROXY_BIDI_USE_ROXYBROWSER_API=1`). The MCP parity tests reuse this to connect both MCP implementations to one shared Chrome-kernel RoxyBrowser profile.

## TDD workflow (mandatory for `src/**` changes)

New features and bug fixes that modify the main runtime/library code under `src/**` follow strict TDD — do not write implementation first.

This strict TDD requirement is intentionally scoped to production code in `src/**` and the tests that guard that code. It does **not** apply to docs-only edits, examples-only work under `examples/**`, scripts/tooling-only changes, or one-off reproduction examples. If an example reveals or accompanies a real `src/**` behavior change, add the failing regression test first, then fix the implementation.

1. **Design the interface first.** Define the types/signatures the new code will expose (a function, a `Tool`, an adapter method, a `HumanController` hook, etc.). Put shared types in `src/types/*` or the relevant module's types file. The interface is the contract you build against.
2. **Define input/output formats.** Specify the exact input shape (zod schema for MCP tools, options object for library APIs) and the output/return shape before any logic. For MCP tools, the zod `inputSchema` is the source of truth. For protocol backends, the adapter interface is the source of truth.
3. **Write the test suite.** Unit tests in `tests/unit/` for logic, serialization, option resolution, and pure behavior; e2e tests in `tests/e2e/` (or `tests/e2e/bidi/`) for anything that needs a real browser; contract/parity tests in `tests/mcp-parity/` for cross-implementation behavior. Run the suite and confirm the new tests **fail for the right reason** (RED).
4. **Implement until green.** Write the minimum code to pass, then run the suite again.
5. **Refactor** within the green bar, keeping the 90% coverage threshold intact.

For bug fixes in `src/**`: first add a failing test that reproduces the bug (this is the regression guard), then fix the implementation. Never "just patch" production runtime/library code without a test that would have caught it.

When a feature spans both the library surface and the MCP tool surface, write the test at the level the user will hit — MCP tools are exercised through the runtime/server (`tests/unit/mcp.test.ts`, `tests/mcp-parity/`), not by calling internals directly.

## Conventions

- ESM + NodeNext: every relative TS import ends in `.js`.
- `tsconfig` is strict with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` — spreading `undefined` into an options object or indexing without a guard will fail the build. Use the `...(x !== undefined ? { k: x } : {})` pattern for optional properties.
- The public API mirrors Playwright naming on purpose; when adding methods, match Playwright's signature shape so users don't have to relearn.
- Examples are grouped by entry point: `examples/mcp/` for MCP tool examples, `examples/page/` for direct Browser/Context/Page API examples, and `examples/repro/` for bug reproductions. Run them through `pnpm examples <module> <script>` so `ROXY_CDP_ENDPOINT` / `ROXY_BIDI_ENDPOINT` are injected consistently; runnable `.mjs` examples import the package by its published name (`@roxybrowser/playwright`), and the `examples/mcp/verify-*.mjs` ones drive the MCP server end-to-end and double as integration checks.
