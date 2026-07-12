# Unified Asset Management Redesign

This document describes the target design for asset management in
`@roxybrowser/playwright` and `roxybrowser-playwright-mcp`.

The current implementation has two unrelated file models:

- Page/Playwright-style usage lets screenshots, downloads, traces, and other
  artifacts depend on ad hoc API behavior or browser defaults.
- MCP usage has its own `outputDir` / `tempDir` helpers in `src/mcp/output.ts`.

That split is the root problem. MCP and Page are two entry points into the same
browser runtime, so they must use the same asset model.

This redesign is intentionally breaking. Do not preserve the old MCP-specific
directory compatibility layer.

## Goals

- One asset manager for Page API, Browser/Context API, and MCP.
- Browser-native downloads never fall back to the system Downloads directory.
- Screenshots, downloads, snapshots, traces, videos, network exports, console
  exports, and script outputs all resolve through the same policy.
- API options are the primary configuration surface. Environment variables are
  only process-level defaults.
- Agent-owned paths are consumed as input. Playwright code must not construct
  agent home paths itself.
- Relative paths resolve inside the active asset root. Absolute paths are only
  allowed when the active policy permits unrestricted writes.

## Playwright Reference Model

Upstream Playwright centralizes launch-level artifact paths and then exposes
finished files through `Artifact` objects.

Relevant reference files:

- `library/playwright/packages/playwright-core/src/server/browserType.ts`
  - Computes `artifactsDir`, `downloadsPath`, and `tracesDir`.
  - Defaults `downloadsPath` and `tracesDir` to `artifactsDir`.
- `library/playwright/packages/playwright-core/src/server/artifact.ts`
  - Owns artifact lifecycle, finish state, `saveAs`, `delete`, `failure`, and
    stream access.
- `library/playwright/packages/playwright-core/src/client/download.ts`
  - `Download` is a wrapper around an `Artifact`.
- `library/playwright/packages/playwright-core/src/server/bidi/bidiBrowser.ts`
  - Applies BiDi `browser.setDownloadBehavior` with `destinationFolder`.
- `library/playwright/packages/playwright-core/src/tools/backend/context.ts`
  - MCP tools resolve client-visible files through a shared context policy.

Roxy should follow the same shape, adapted to its CDP/BiDi adapter layer.

## New Core Modules

Add a shared asset layer under `src/assets/`.

### `src/assets/types.ts`

Define:

```ts
export type AssetKind =
  | "download"
  | "screenshot"
  | "snapshot"
  | "trace"
  | "video"
  | "network"
  | "console"
  | "script"
  | "temporary";

export interface AssetRoots {
  artifactsDir: string;
  downloadsDir: string;
  screenshotsDir: string;
  snapshotsDir: string;
  tracesDir: string;
  videosDir: string;
  networkDir: string;
  consoleDir: string;
  scriptsDir: string;
  tempDir: string;
}

export interface AssetPolicy {
  allowAbsolutePaths: boolean;
  allowSystemDirectories: boolean;
  collisionStrategy: "increment" | "timestamp" | "error";
}
```

### `src/assets/manager.ts`

`AssetManager` owns all file resolution:

- Resolve roots from API options and environment variables.
- Validate roots.
- Create directories lazily.
- Sanitize suggested filenames.
- Resolve relative filenames under the correct kind directory.
- Apply collision policy.
- Return both absolute paths and client-facing relative paths.

### `src/artifact.ts`

Introduce `RoxyArtifact`:

- `pathAfterFinished()`
- `saveAs(path)`
- `createReadStream()`
- `failure()`
- `cancel()`
- `delete()`
- `reportFinished(error?)`

Downloads, videos, traces, and generated files should use this object instead
of passing raw file paths through event payloads.

### `src/download.ts`

Introduce `RoxyDownload` implementing the public `Download` interface. It wraps
`RoxyArtifact`, matching the upstream Playwright model.

## Public Options

Update `src/types/options.ts`.

### Launch / Connect Options

Add:

```ts
export interface AssetOptions {
  artifactsDir?: string;
  downloadsDir?: string;
  screenshotsDir?: string;
  snapshotsDir?: string;
  tracesDir?: string;
  videosDir?: string;
  networkDir?: string;
  consoleDir?: string;
  scriptsDir?: string;
  tempDir?: string;
  allowAbsoluteAssetPaths?: boolean;
}
```

Then include `AssetOptions` in:

- `LaunchOptions`
- `ConnectOverCDPOptions`
- `BrowserConnectOptions`
- MCP server options

### Browser Context Options

Add:

```ts
acceptDownloads?: boolean;
downloadsDir?: string;
```

Defaults:

- `acceptDownloads` defaults to `true`.
- `downloadsDir` defaults to the active `AssetManager.downloadsDir`.
- Explicit context options override launch/connect defaults.

## Environment Variables

Environment variables are process defaults only. API options always win.

Supported variables:

- `ROXY_PLAYWRIGHT_ARTIFACTS_DIR`
  - Root for durable assets when no API option is provided.
- `ROXY_PLAYWRIGHT_DOWNLOADS_DIR`
  - Overrides only browser downloads.
- `ROXY_PLAYWRIGHT_SCREENSHOTS_DIR`
  - Overrides screenshots.
- `ROXY_PLAYWRIGHT_SNAPSHOTS_DIR`
  - Overrides accessibility snapshots and snapshot markdown files.
- `ROXY_PLAYWRIGHT_TRACES_DIR`
  - Overrides traces.
- `ROXY_PLAYWRIGHT_VIDEOS_DIR`
  - Overrides videos and screencast recordings.
- `ROXY_PLAYWRIGHT_NETWORK_DIR`
  - Overrides network exports.
- `ROXY_PLAYWRIGHT_CONSOLE_DIR`
  - Overrides console exports.
- `ROXY_PLAYWRIGHT_SCRIPTS_DIR`
  - Overrides sandbox or run-code generated files.
- `ROXY_PLAYWRIGHT_TEMP_DIR`
  - Overrides short-lived runtime files.
- `SANDBOX_OUTPUT_DIR`
  - Agent sandbox contract. When present and no API asset option is provided,
    it becomes the default `artifactsDir`, `downloadsDir`, and `scriptsDir`.

Do not support these old MCP-specific variables after the redesign:

- `ROXY_MCP_OUTPUT_DIR`
- `PLAYWRIGHT_MCP_OUTPUT_DIR`
- `ROXY_MCP_TEMP_DIR`
- `PLAYWRIGHT_MCP_TEMP_DIR`

The removal is deliberate. The package should have one Playwright-level asset
configuration surface, not a separate MCP surface.

## Resolution Order

For each asset kind:

1. Explicit API option for that kind.
2. Explicit `artifactsDir` API option plus kind subdirectory.
3. Kind-specific `ROXY_PLAYWRIGHT_*_DIR` environment variable.
4. `SANDBOX_OUTPUT_DIR` for sandbox-owned assets.
5. `ROXY_PLAYWRIGHT_ARTIFACTS_DIR` plus kind subdirectory.
6. A generated temporary artifacts root under `os.tmpdir()`.

Recommended default subdirectories:

- downloads: `downloads/`
- screenshots: `screenshots/`
- snapshots: `snapshots/`
- traces: `traces/`
- videos: `videos/`
- network: `network/`
- console: `console/`
- scripts: `scripts/`
- temporary: `tmp/`

## Protocol Backend Changes

### CDP

Update `src/protocol/cdp/backend.ts`.

- Store the resolved `AssetManager` in browser/session/context state.
- On browser connect and context creation, apply download behavior:
  - Prefer `Browser.setDownloadBehavior`.
  - Fall back to `Page.setDownloadBehavior`.
- Apply behavior to:
  - Existing pages discovered during `connect()`.
  - Pages created by `newPage()`.
  - Popup pages and late-attached targets.
- Do not silently ignore download behavior failures when downloads are accepted.
  Return a clear warning or throw depending on policy.
- Convert download protocol events into `RoxyDownload` objects.

### BiDi / Firefox

Update `src/protocol/bidi/backend.ts`.

- Use BiDi `browser.setDownloadBehavior` when supported:
  - `allowed` with `destinationFolder = downloadsDir`
  - `denied` when `acceptDownloads === false`
- Convert `browsingContext.downloadWillBegin` and
  `browsingContext.downloadEnd` into `RoxyDownload` / `RoxyArtifact`.
- If the current Roxy Firefox bridge does not expose the needed command, add it
  to the bridge instead of papering over it in MCP.

## MCP Changes

MCP should consume the shared asset layer, not own a separate output system.

Update:

- `src/mcp/types.ts`
  - Replace `outputDir` / `tempDir` with shared `AssetOptions`.
- `src/mcp/runtime.ts`
  - Own one `AssetManager`.
  - Pass it or its resolved roots into `connectBrowserSession`.
- `src/mcp/backend/context.ts`
  - Delete MCP-specific file resolution.
  - Delegate all file decisions to `AssetManager`.
- `src/mcp/backend/response.ts`
  - File links and image results should receive `ResolvedAsset` objects.
- `src/mcp/backend/screenshot.ts`
  - Screenshots save through the screenshot asset kind.
- `src/mcp/backend/snapshot.ts`
  - Snapshot markdown saves through the snapshot asset kind.
- Network, console, evaluate, run-code, upload, trace, and future tools must use
  the same asset API.

Delete `src/mcp/output.ts` after callers are migrated.

## CLI Changes

Update `src/bin/roxybrowser-mcp.ts`.

Remove:

- `--output-dir`
- `--temp-dir`

Add:

- `--artifacts-dir`
- `--downloads-dir`
- `--screenshots-dir`
- `--snapshots-dir`
- `--traces-dir`
- `--videos-dir`
- `--network-dir`
- `--console-dir`
- `--scripts-dir`
- `--temp-dir`

`--temp-dir` remains, but it now maps to the shared asset option instead of the
old MCP temp model.

## Agent Integration

Agent should pass explicit API options instead of relying on old MCP env names.

MCP worker:

```ts
createInProcessPlaywrightMcpClient(serverName, {
  artifactsDir: agentPaths.browserDirForToday(),
  downloadsDir: agentPaths.browserDownloadsDir(),
  snapshotsDir: agentPaths.browserSnapshotsDir(),
  tracesDir: agentPaths.browserTracesDir(),
  tempDir: agentPaths.browserTempDir(),
});
```

Sandbox:

- `process.cwd()` remains the script asset directory.
- `SANDBOX_OUTPUT_DIR` may be set to the same directory.
- Injected Playwright should resolve `downloadsDir` and `scriptsDir` to that
  directory unless explicit API options override it.

## Migration Steps

1. Add `src/assets/*`, `src/artifact.ts`, and `src/download.ts`.
2. Add asset options to public types and MCP server types.
3. Wire `AssetManager` through `RoxyBrowserType`, `RoxyBrowser`, and context
   creation.
4. Implement CDP download behavior and download artifact events.
5. Implement BiDi download behavior and download artifact events.
6. Migrate MCP context/response/tools to `AssetManager`.
7. Delete `src/mcp/output.ts` and old env variable support.
8. Update CLI options and README/developer docs.
9. Remove agent-side temporary download monkey patches.

## Test Matrix

Unit tests:

- Asset root resolution order.
- Environment variables.
- Sandbox resolution from `SANDBOX_OUTPUT_DIR`.
- Relative path resolution per asset kind.
- Absolute path rejection by default.
- System directory rejection.
- Filename sanitization and collision handling.
- `RoxyArtifact.saveAs()` before and after finish.
- `RoxyDownload` public API.
- MCP runtime passes resolved asset roots to connected sessions.
- CDP download behavior uses browser command and page fallback.
- BiDi download behavior sends `browser.setDownloadBehavior`.

E2E tests:

- Page API `<a download>` lands in `downloadsDir`.
- Page API `download.saveAs(path.join(process.cwd(), name))` still works.
- Sandbox download lands in script asset directory.
- MCP-triggered download lands in MCP downloads directory.
- Screenshot, snapshot, trace, video, network, and console exports land under
  their configured asset directories.
- No test creates files under the system Downloads directory.

## Completion Criteria

- There is no MCP-only output path resolver.
- There is no fallback to system Downloads for accepted downloads.
- Page API and MCP produce files through the same `AssetManager`.
- All supported environment variables are documented in this file and in the
  package README.
- Old MCP-specific environment variables are removed from code and tests.
