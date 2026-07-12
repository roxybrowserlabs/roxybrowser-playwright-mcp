# Workflows

Use these patterns as starting points. Keep actions humanized and verify outcomes.

## Basic Browse And Act

1. `roxy_browser_connect`
2. `browser_tabs` with `action: "list"` if the active tab is uncertain
3. `browser_navigate` when a URL is needed
4. `browser_snapshot`
5. Interact by ref: click, type, press, scroll, hover, drag, select, or fill form
6. `browser_wait_for` with expected text or disappearance
7. Verify with `browser_snapshot`

## Search

1. Navigate or select the search page.
2. `browser_snapshot`
3. Find the search textbox ref.
4. `browser_type` with `submit: true`, or type then `browser_press_key` with `Enter`.
5. `browser_wait_for` using result text or a page marker.
6. Verify results with `browser_snapshot` or `browser_evaluate` for structured extraction.

## Login Or Account-Sensitive Flow

1. Use `browser_snapshot` to identify fields and buttons.
2. Type credentials with `human.profile: "cautious"`.
3. Submit with `browser_click` or `browser_press_key`.
4. Wait for a real success signal: dashboard text, URL change, user menu, or error text disappearing.
5. Verify with `browser_snapshot`. Use network and console only if login fails.

## Form Fill

Use `browser_fill_form` for ordinary visible controls when several fields must be filled. Use individual tools when the form has conditional steps, masked inputs, custom widgets, or validation after each field.

Recommended flow:

1. `browser_snapshot`
2. Map each field to its exact ref and type.
3. `browser_fill_form` for textboxes, checkboxes, radios, comboboxes, and sliders.
4. Use `browser_select_option` for dropdowns that need precise option handling.
5. Use `browser_wait_for` for validation or enabling submit.
6. Verify the filled state.

## File Upload

1. `browser_snapshot`
2. Find the upload button, dropzone, or "Choose file" trigger.
3. Optional: call `browser_network_requests` as a baseline.
4. `browser_click` the upload trigger with `human.profile: "cautious"` when the site is sensitive.
5. Immediately call `browser_file_upload` with absolute paths.
6. `browser_wait_for` using upload completion text, filename, thumbnail, progress disappearance, or submit enablement.
7. Verify UI with `browser_snapshot`.
8. Verify API with `browser_network_requests`, then `browser_network_request` for the upload request and response body when needed.

If no file chooser appears, refresh `browser_snapshot`, hover/scroll if necessary, and retry the visible upload affordance. Use `browser_drop` only for dropzone flows.

## Drag And Drop

1. `browser_snapshot`
2. Identify source and target refs.
3. Use `browser_drag` with both refs.
4. Wait for a visible result.
5. Verify with snapshot or evaluate.

For external file or MIME data drag/drop, use `browser_drop` instead.

## Network Debug

1. Reproduce the action with normal MCP interactions.
2. `browser_network_requests` with a `filter` when the endpoint is known.
3. Inspect the relevant index with `browser_network_request`.
4. Use `part: "request-body"` or `part: "response-body"` only when the summary says bodies are available or the payload is required.
5. Cross-check UI state with `browser_snapshot`.
6. Use `browser_console_messages` for client-side errors.

## Multi-Tab

1. `browser_tabs` with `action: "list"`.
2. Select by index only after confirming the list.
3. For new pages, use `browser_tabs` with `action: "new"` and optional `url`.
4. Always call `browser_snapshot` after selecting or creating a tab unless the tool response already includes enough state.

## Large Result Capture

Use `filename` when output could be long:

- `browser_snapshot`
- `browser_take_screenshot`
- `browser_evaluate`
- `browser_network_requests`
- `browser_network_request`
- `browser_console_messages`

Then summarize the saved artifact path and the relevant findings.
