# Playwright Snapshot Source

This directory intentionally keeps only the readable Playwright source files
that are relevant to `browser_snapshot` parity.

`../generated/injectedScriptSource.ts` is generated from this directory by
`pnpm build:vendor:snapshot`. The generated file exists only because the browser
evaluate call needs one executable injected script string.

Snapshot entry:

- `injected/injectedScript.snapshot.ts` is the tiny Playwright `InjectedScript`
  entrypoint used by `page.ariaSnapshot()`.
- `injected/ariaSnapshot.ts` renders the accessibility tree.
- `injected/roleUtils.ts` computes ARIA roles, names, states, and CSS generated
  content.
- `injected/domUtils.ts` contains the DOM visibility and box helpers used by
  the snapshot renderer.

Internal helpers:

- `isomorphic/ariaSnapshot.ts`
- `isomorphic/cssTokenizer.ts`
- `isomorphic/stringUtils.ts`
- `isomorphic/yaml.ts`

The upstream Playwright files use `@isomorphic/*` aliases inside their monorepo.
In this vendored copy those imports are rewritten to relative paths, so no
`@isomorphic` package is required in `package.json`.

Files such as Playwright recorder overlays, highlight CSS, selector engines, and
SVG icons are deliberately excluded because they are not part of MCP
`browser_snapshot`.
