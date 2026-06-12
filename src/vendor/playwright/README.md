# Playwright Snapshot Vendor

This directory vendors the Playwright injected snapshot implementation used by
`page.ariaSnapshot({ mode: "ai" })` so RoxyBrowser MCP can match
`@playwright/mcp` without importing Playwright at runtime.

- Source package: `playwright-core@1.61.0-alpha-1781023400000`
- Source commit: `e8e8d69569de6ad8885b50664bdfd0dc3e8315ed`
- Readable source root: `library/playwright/packages/injected/src`
- Readable source root: `library/playwright/packages/isomorphic`
- License: Apache-2.0

Layout:

- `source/` is the readable, snapshot-only Playwright source copied from
  `library/playwright`. It intentionally excludes recorder overlays,
  highlighter CSS, selector engines, SVG icons, and other non-snapshot injected
  features.
- `generated/` contains the browser-executable injected bundle generated from
  that source shape. It is intentionally treated as build output.
- `ariaSnapshotEvaluate.ts` is the small Roxy wrapper around the generated
  injected bundle. It calls Playwright's vendored `incrementalAriaSnapshot`
  path and adapts the result to the existing Roxy MCP snapshot/cache shape.
