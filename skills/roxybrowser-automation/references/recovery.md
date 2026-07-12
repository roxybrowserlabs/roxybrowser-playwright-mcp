# Recovery

Use this file when an MCP browser action fails, hangs, or returns confusing page state.

## Stale Or Invalid Ref

Symptom: a tool says the referenced element is no longer valid, target is missing, or the page changed.

1. Call `browser_snapshot`.
2. Re-identify the element by role, label, nearby text, or unique selector.
3. Retry once with the new ref.
4. If it fails again, inspect dynamic state with `browser_wait_for`, `browser_console_messages`, or `browser_evaluate`.

## Element Missing

1. Confirm the active tab with `browser_tabs`.
2. Confirm navigation finished or wait for expected text.
3. Try `browser_snapshot` with smaller `depth` or a relevant `target`.
4. Scroll with `browser_scroll`, then snapshot again.
5. Use `browser_hover` if the control is revealed by hover.
6. Use `browser_take_screenshot` if this is a visual-only or canvas-heavy UI.

## Modal State

If a tool says it does not handle the modal state, clear the modal first:

- File chooser: call `browser_file_upload` with paths, or omit `paths` to cancel.
- Browser dialog: call `browser_handle_dialog`.

Do not keep clicking, typing, or evaluating around the modal unless you are explicitly diagnosing why the modal cannot be cleared.

## Dynamic Page Race

1. Prefer `browser_wait_for` with `text` or `textGone`.
2. Use a short `time` wait only when no textual signal exists.
3. Refresh `browser_snapshot`.
4. If UI still looks stale, inspect network and console messages.

## Upload Did Not Complete

1. Verify that `browser_file_upload` ran after the file chooser opened.
2. Check the UI for progress, filename, thumbnail, or error text.
3. Check network requests for upload or processing endpoints.
4. Read request/response details for the relevant request index.
5. Check console errors.
6. Retry once only after identifying the likely failed stage.

## Network Request Missing

1. Make sure the action was triggered after navigation.
2. Wait for a real page signal or a short time.
3. Call `browser_network_requests` again.
4. Use `filter` for the endpoint or path.
5. Use `static: true` only when diagnosing scripts, images, fonts, or other static assets.

## Snapshot Too Large

Use one of:

- `depth` to limit tree depth
- `target` to inspect a subtree
- `filename` to save the full snapshot
- `boxes: true` only when coordinates or layout are needed

## Visual Issue

Use `browser_take_screenshot` when the accessibility snapshot cannot show the problem: canvas content, video frame, image rendering, overlap, clipping, animation state, or responsive layout.

## JavaScript Fallback

Use `browser_evaluate` to inspect state. Use `browser_run_code_unsafe` only when standard tools cannot reach the needed state or instrumentation.

When using JavaScript fallback:

1. State why normal MCP tools were insufficient.
2. Keep the script narrow and read-only when possible.
3. Return structured data.
4. Go back to normal MCP interaction tools after diagnosis.
