# Tool Catalog

Use this file when choosing between RoxyBrowser MCP tools.

## Connection

`roxy_browser_connect`
: Attach to an existing browser endpoint. Required before page tools. Use `browser: "chrome"` for CDP Chromium sessions and `browser: "firefox"` for BiDi Firefox sessions. Pass `sessionId` when reconnecting a known session.

`browser_close`
: Close the current browser session.

## Tabs And Viewport

`browser_tabs`
: List, create, select, or close tabs. Use `action: "list"` to confirm tab indexes before selecting or closing.

`browser_resize`
: Resize the active page viewport when responsive behavior matters.

## Navigation

`browser_navigate`
: Navigate the active tab to a URL. Inspect the returned snapshot or call `browser_snapshot` after dynamic loads.

`browser_navigate_back` and `browser_navigate_forward`
: Move through history and refresh page state.

`browser_wait_for`
: Wait for `text`, `textGone`, or a short `time` in seconds. Prefer text-based waits over time waits. Time waits are capped internally.

## Page State

`browser_snapshot`
: Primary page-understanding tool. It returns accessibility structure and stable element refs. Options: `target`, `depth`, `boxes`, `filename`.

`browser_take_screenshot`
: Use for visual verification, screenshots, canvas, image, video, layout, and overlap checks. Use `filename` for artifacts.

`browser_evaluate`
: Evaluate `() => {}` on the page, or `(element) => {}` when `target` is provided. Use for inspection and extraction, not normal interaction.

## Humanized Input

`browser_click`
: Click an element by snapshot ref or unique selector. Supports `doubleClick`, `button`, `modifiers`, and `human.profile`.

`browser_type`
: Type into an editable element. Supports `submit` and `human.profile`.

`browser_press_key`
: Press keyboard keys such as `Enter`, `Escape`, `Tab`, arrows, `Backspace`, and printable characters. Supports `human.profile`.

`browser_scroll`
: Scroll the page or an element. Requires non-zero `deltaX` or `deltaY`. Supports `human.profile`.

`browser_hover`
: Hover over an element to reveal menus, tooltips, or hover-only controls.

`browser_drag`
: Drag from one snapshot ref to another.

`browser_select_option`
: Select dropdown options by value or visible label.

`browser_fill_form`
: Fill multiple form controls in one operation. Use for ordinary visible fields; handle file upload separately.

## Files And External Data

`browser_file_upload`
: Complete or cancel an open file chooser. Call it immediately after clicking a file upload trigger. Use absolute file paths.

`browser_drop`
: Drop files or MIME-typed data onto a target element, as if dragged from outside the page.

## Dialogs

`browser_handle_dialog`
: Accept or dismiss an alert, confirm, or prompt. Use `promptText` for prompt dialogs.

## Debugging

`browser_network_requests`
: List network requests since page load. By default, successful static resources are hidden. Use `filter` for URL regexes and `static: true` when diagnosing assets.

`browser_network_request`
: Inspect a request by 1-based index from `browser_network_requests`. Use `part` for `request-headers`, `request-body`, `response-headers`, or `response-body`.

`browser_console_messages`
: Read console output and JavaScript errors.

`browser_run_code_unsafe`
: Last resort. Run arbitrary code against the session only when standard tools cannot inspect or operate the page.
