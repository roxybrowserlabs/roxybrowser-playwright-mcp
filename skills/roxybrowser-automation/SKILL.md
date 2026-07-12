---
name: roxybrowser-automation
description: Use when an agent has access to RoxyBrowser MCP tools such as roxy_browser_connect or browser_* and needs to browse, inspect, automate, test, upload files, debug pages, or interact with websites through a real browser session.
---

# RoxyBrowser Automation

## Core Idea

Use RoxyBrowser MCP as a real humanized browser session, not as a raw DOM scripting API. Prefer snapshots and MCP interaction tools; reserve JavaScript for inspection, extraction, and last-resort recovery.

Default loop:

1. Connect with `roxy_browser_connect`.
2. Navigate, select, or create the right tab.
3. Read page state with `browser_snapshot`.
4. Act with snapshot refs using humanized interaction tools.
5. Wait for observable page changes.
6. Verify with snapshot, evaluate, network, console, or screenshot.
7. Refresh snapshot and reacquire refs when the page changes.

## Golden Rules

- Prefer `browser_snapshot` over screenshots for understanding page structure.
- Prefer `browser_click`, `browser_type`, `browser_scroll`, `browser_drag`, `browser_hover`, `browser_press_key`, `browser_select_option`, and `browser_fill_form` over JavaScript for interactions.
- Use exact snapshot refs when available. Use unique selectors only when refs are unavailable or stale.
- Refresh `browser_snapshot` after navigation, major DOM changes, failed actions, or stale-ref messages.
- Use `browser_wait_for` with `text` or `textGone` before blind time waits.
- Treat `browser_run_code_unsafe` as a last resort for debugging or custom instrumentation.
- Keep interactions humanized by default. Use `human.profile: "cautious"` for logins, checkout, upload, account changes, and anti-bot-sensitive flows; use `"fast"` only for low-risk tests.

## Quick Start

```text
roxy_browser_connect -> browser_tabs/list if needed -> browser_navigate
-> browser_snapshot -> browser_click/browser_type/etc.
-> browser_wait_for -> browser_snapshot/evaluate/network/console
```

If a ref is stale, call `browser_snapshot`, find the new ref, and retry once.

## Tool Choice

Use `browser_snapshot` first. Add `depth` to shrink output, `target` to inspect a subtree, `boxes: true` when layout matters, and `filename` for large snapshots.

Use `browser_take_screenshot` when visual appearance matters: canvas, video, images, layout, overlap, or visual regressions.

Use `browser_evaluate` for structured inspection, computed DOM/app state, or data extraction. Do not use it to bypass normal clicks, typing, upload, or scrolling unless the page cannot be operated normally.

Use `browser_network_requests`, `browser_network_request`, and `browser_console_messages` after reproducing an action.

Read `references/tool-catalog.md` when choosing among similar tools or checking exact tool roles.

## Common Workflows

For uploads, forms, login, search, network debugging, drag/drop, tabs, and dynamic flows, read `references/workflows.md`.

For stale refs, missing elements, modal state, page races, large snapshots, and protocol quirks, read `references/recovery.md`.

## Modal And File States

Some page states must be cleared by the matching tool before other interaction tools can proceed:

- File chooser: call `browser_file_upload` with absolute paths, or omit paths to cancel.
- Dialog: call `browser_handle_dialog`.

If another tool reports modal state, stop and clear it first.

## Verification

Do not claim completion from one successful click. Verify:

- UI state: `browser_snapshot`
- Visual state: `browser_take_screenshot`
- DOM/app state: `browser_evaluate`
- API result: `browser_network_requests` then `browser_network_request`
- JavaScript errors: `browser_console_messages`

Save large outputs with `filename` instead of returning them in chat.
