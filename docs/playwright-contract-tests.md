# Playwright Contract Tests

This repository now keeps a small compatibility suite that is intentionally derived from upstream Playwright specs, but only for APIs that RoxyBrowser already exposes today.

## Current contract files

- [tests/e2e/page/page-click.contract.test.ts](/Users/macos/code/roxy-company/roxybrowser-playwright-mcp/tests/e2e/page/page-click.contract.test.ts:1)
  Backed by:
  - `library/playwright/tests/page/page-click.spec.ts`
  - `library/playwright/tests/page/page-click-timeout-1.spec.ts`
  Notes:
  - This suite now covers basic clicks, tiny 1x1 hit targets, generated content, inline children outside the viewport, `clickCount: 3`, checkbox toggling, wrapped links, and reusing `page.click()` after navigation.
  - This suite now also covers SVG hit-testing and auto-waiting for `display:none` / `visibility:hidden` elements to become clickable within the timeout window.

- [tests/e2e/page/page-events.contract.test.ts](/Users/macos/code/roxy-company/roxybrowser-playwright-mcp/tests/e2e/page/page-events.contract.test.ts:1)
  Backed by:
  - `library/playwright/tests/page/page-event-console.spec.ts`
  - `library/playwright/tests/page/page-event-load.spec.ts`
  - `library/playwright/tests/page/page-event-request.spec.ts`
  - `library/playwright/tests/page/page-event-network.spec.ts`
  - `library/playwright/tests/page/page-network-response.spec.ts`
  Notes:
  - This suite now covers `console` event waiting, duplicate logs, console API type mapping, `once()` / `removeListener()` listener semantics, `domcontentloaded` before `load`, main-frame-only `load` semantics, main-resource request/response events, iframe and fetch request events, request-before-response ordering, and `requestfailed` for broken stylesheets.

- [tests/e2e/page/page-snapshot.contract.test.ts](/Users/macos/code/roxy-company/roxybrowser-playwright-mcp/tests/e2e/page/page-snapshot.contract.test.ts:1)
  Backed by:
  - `library/playwright/tests/page/page-aria-snapshot-ai.spec.ts`
  Notes:
  - This suite now covers top-level AI refs, `resolveAriaRef()` selector metadata, duplicate-id structural selectors, shadow DOM ref metadata, generic wrapper collapse, cursor-pointer hints, active element markers, and default-mode ref invalidation.

- [tests/e2e/page/page-selectors.contract.test.ts](/Users/macos/code/roxy-company/roxybrowser-playwright-mcp/tests/e2e/page/page-selectors.contract.test.ts:1)
  Backed by:
  - `library/playwright/tests/page/selectors-get-by.spec.ts`
  - `library/playwright/tests/page/selectors-text.spec.ts`
  - `library/playwright/tests/page/locator-query.spec.ts`
  Notes:
  - This suite now covers `getByText` whitespace normalization and exact matching, `getByRole` with button names, `aria-label`, and associated `<label>` names, Playwright-style strictness for ambiguous locators, nested locator chaining, `first()/last()/nth()`, `xpath=` queries, and `text=` selector engine queries through page APIs.

- [tests/e2e/browser-context/browser-context-basic.contract.test.ts](/Users/macos/code/roxy-company/roxybrowser-playwright-mcp/tests/e2e/browser-context/browser-context-basic.contract.test.ts:1)
  Backed by:
  - `library/playwright/tests/library/browsercontext-basic.spec.ts`
  Notes:
  - This suite now covers storage isolation and parallel click behavior across contexts.

- [tests/mcp-parity/mcp-dialog-network.contract.test.ts](/Users/macos/code/roxy-company/roxybrowser-playwright-mcp/tests/mcp-parity/mcp-dialog-network.contract.test.ts:1)
  Backed by:
  - `library/playwright/tests/mcp/dialogs.spec.ts`
  - `library/playwright/tests/mcp/network.spec.ts`

## Existing Playwright-derived coverage already in the repo

- [tests/e2e/page/eval-on-selector.test.ts](/Users/macos/code/roxy-company/roxybrowser-playwright-mcp/tests/e2e/page/eval-on-selector.test.ts:1)
  Backed by:
  - `library/playwright/tests/page/eval-on-selector.spec.ts`

- [tests/e2e/page/eval-on-selector-all.test.ts](/Users/macos/code/roxy-company/roxybrowser-playwright-mcp/tests/e2e/page/eval-on-selector-all.test.ts:1)
  Backed by:
  - `library/playwright/tests/page/eval-on-selector-all.spec.ts`

- [tests/e2e/page/elementhandle-eval-on-selector.test.ts](/Users/macos/code/roxy-company/roxybrowser-playwright-mcp/tests/e2e/page/elementhandle-eval-on-selector.test.ts:1)
  Backed by:
  - `library/playwright/tests/page/elementhandle-eval-on-selector.spec.ts`

- [tests/e2e/page/page-history.test.ts](/Users/macos/code/roxy-company/roxybrowser-playwright-mcp/tests/e2e/page/page-history.test.ts:1)
  Backed by:
  - `library/playwright/tests/page/page-history.spec.ts`

- [tests/e2e/page/page-network-response.test.ts](/Users/macos/code/roxy-company/roxybrowser-playwright-mcp/tests/e2e/page/page-network-response.test.ts:1)
  Backed by:
  - `library/playwright/tests/page/page-network-response.spec.ts`
  Notes:
  - This suite now covers `response.text()`, response headers, MIME type, cache flag exposure, custom status text, and waiting for streaming response bodies to fully complete before `text()` resolves.

- [tests/e2e/page/page-wait-for-selector.test.ts](/Users/macos/code/roxy-company/roxybrowser-playwright-mcp/tests/e2e/page/page-wait-for-selector.test.ts:1)
  Backed by:
  - `library/playwright/tests/page/page-wait-for-selector-1.spec.ts`
  - `library/playwright/tests/page/page-wait-for-selector-2.spec.ts`
  Notes:
  - This suite now covers `attached` / `visible` / `hidden` / `detached` state handling, text selectors, shadow DOM and distributed content cases, attribute mutation, zero-sized visibility checks, hiding by removal, and both page/element-handle waiters.
  - Runtime validation now matches Playwright for invalid `state` values and unsupported `visibility` options.

- [tests/e2e/page/page-snapshot-iframe.test.ts](/Users/macos/code/roxy-company/roxybrowser-playwright-mcp/tests/e2e/page/page-snapshot-iframe.test.ts:1)
  Backed by:
  - `library/playwright/tests/page/page-aria-snapshot-ai.spec.ts`
  Notes:
  - This suite now covers iframe-prefixed aria refs and `resolveAriaRef()` across same-origin iframe boundaries.

## Expansion rule

When adding more compatibility coverage, prefer this order:

1. Only pull from upstream specs for APIs already exposed in `src/types/api.ts`.
2. Keep tests deterministic and local-fixture based whenever possible.
3. Preserve a note in the test file or this document pointing back to the upstream Playwright spec.
