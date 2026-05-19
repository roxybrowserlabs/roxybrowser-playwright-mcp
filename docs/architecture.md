# Architecture

## Goals

1. Match the Playwright mental model: `chromium -> browser -> context -> page -> locator`.
2. Make humanized input the default execution strategy instead of a separate opt-in API.
3. Support CDP first through `chrome-remote-interface`.
4. Avoid coupling the public API to CDP-only concepts so BiDi and WebDriver can be added later.

## Layering

### 1. Public API layer

This layer exposes Playwright-style objects:

- `BrowserType`
- `Browser`
- `BrowserContext`
- `Page`
- `Locator`

This layer should remain stable even when the transport changes from CDP to BiDi or WebDriver.

### 2. Humanization layer

Humanization sits between the public API and the protocol adapter. The user still calls:

- `page.click(...)`
- `locator.fill(...)`
- `locator.type(...)`
- `page.hover(...)`

But those methods route through a `HumanController` that decides cadence, jitter, pre-hover, segmented scroll, and typing rhythm. That keeps the public API Playwright-compatible while making behavior distinctly roxybrowser.

### 3. Protocol adapter layer

The adapter layer normalizes backend operations into browser automation primitives:

- connect or launch
- create context
- create page
- navigate
- evaluate
- query locator
- dispatch low-level pointer and keyboard actions

This layer is where CDP and future BiDi implementations diverge.

### 4. Raw transport layer

This layer talks to concrete protocols:

- CDP via `chrome-remote-interface`
- later BiDi via WebDriver session bootstrapping

The raw transport should not leak into `Page` or `Locator`.

## Why not bind the API directly to CDP

CDP is strong for Chromium now, but the long-term direction includes BiDi and WebDriver session management. If `Page` directly depends on CDP domains like `Runtime`, `DOM`, or `Input`, the future BiDi integration becomes a rewrite. The adapter boundary prevents that.

## Proposed directory responsibilities

- `src/types`
  Public options and interface contracts.
- `src/browserType.ts`
  `chromium.launch()` and future `connect()` entry points.
- `src/browser.ts`
  Browser lifecycle and context creation.
- `src/browserContext.ts`
  Context lifecycle, per-context defaults, shared humanization policy.
- `src/page.ts`
  Page-level APIs and selector-based convenience methods.
- `src/locator.ts`
  Locator composition, chainability, and action routing.
- `src/human`
  Humanization profiles and orchestration.
- `src/protocol/adapter.ts`
  Normalized backend contracts.
- `src/protocol/cdp/backend.ts`
  CDP implementation backed by `chrome-remote-interface`.
- `src/protocol/bidi/backend.ts`
  BiDi placeholder with the same adapter contract.
- `src/protocol/webdriver/backend.ts`
  WebDriver session placeholder for future BiDi bootstrapping and fallback flows.

## Compatibility strategy

### API compatibility

The package should keep Playwright naming and object hierarchy so migration cost is low. Where behavior differs, the main difference should be execution style, not method naming.

### Capability compatibility

Not every protocol supports the same primitives. Each backend exposes a capability map so unsupported features fail explicitly instead of silently degrading.

Examples:

- CDP may support deep Chromium-specific hooks earlier.
- BiDi may standardize navigation and log events differently.
- WebDriver bootstrapping may own session creation before BiDi becomes available.

## Backend selection

`chromium.launch({ protocol })` selects a backend through a protocol registry:

- `cdp`: default path, backed by `chrome-remote-interface`
- `bidi`: reserved normalized backend for future BiDi execution
- `webdriver`: reserved for WebDriver-managed session bootstrap and fallback execution

This means protocol choice is decided once at launch time, while the public API remains unchanged.

## Humanization strategy

Humanization should be policy-driven:

- profile presets: `cautious`, `balanced`, `fast`
- per-browser defaults
- per-context overrides
- per-action overrides

The policy object should be resolved once and merged downward:

1. launch defaults
2. context overrides
3. action overrides

## Implementation phases

1. Finalize package structure and public contracts.
2. Implement CDP transport bootstrapping with `chrome-remote-interface`.
3. Implement page navigation, locator resolution, and basic evaluation.
4. Implement low-level mouse, keyboard, and scroll dispatch.
5. Add humanized movement and typing strategies.
6. Add BiDi backend reusing the same public API and humanization layer.
