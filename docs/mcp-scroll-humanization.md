# MCP Scroll Humanization

This note records the current `browser_scroll` behavior and the intended
future direction for more realistic wheel-based scrolling.

## Current behavior

`browser_scroll` uses a stability-first DOM scrolling path. The MCP tool accepts:

- `target` (optional): an aria snapshot ref or unique selector. When omitted, the page is scrolled.
- `element` (optional): a human-readable description only; it is not used for element lookup.
- `deltaX` and `deltaY`: scroll deltas in CSS pixels. At least one must be non-zero.
- `human.profile`: `cautious`, `balanced`, or `fast`.

The tool calls `McpRuntime.scroll()`, which resolves the optional target and maps the human profile
to session scroll options:

- `cautious`: smaller chunks, slower cadence.
- `balanced`: default chunk size and cadence.
- `fast`: larger chunks, faster cadence.

The connected browser session then:

1. Splits the requested delta into smaller chunks using the profile's `scrollStepPx`.
2. Applies each chunk with DOM `scrollBy({ left, top, behavior: "instant" })`.
3. Adds profile-based delay between chunks.
4. Occasionally applies a small reverse chunk to mimic a slight over-scroll correction.
5. Occasionally pauses between chunks to mimic a user briefly observing the page.

This path is intentionally not a native wheel event. It is predictable, works for both page and
element scrolling, and avoids page scripts that intercept or cancel `wheel` events.

## Why not wheel by default yet

Native wheel scrolling is more realistic, but it has higher operational risk:

- A wheel event scrolls the area under the current mouse position, not an arbitrary DOM element.
- Offscreen targets require a policy decision: pre-scroll into view, locate a visible scrollable
  ancestor, or fail and ask the agent to scroll the page first.
- Scroll chaining can move from an inner scroll container to its parent or the document.
- Page scripts can call `preventDefault()` on `wheel` and block the scroll.
- CDP and WebDriver BiDi have different wheel input mechanisms and need parity coverage.
- Realistic trackpad or wheel inertia needs careful tuning to avoid flaky tests.

## Future direction

Keep the current `scrollBy` path as the default until wheel behavior has broad e2e coverage. A future
enhancement can add an internal or explicit method selection, for example:

```ts
method: "dom" | "wheel"
```

The wheel path should:

- Move the cursor humanly to a visible point inside the target or scroll container.
- Dispatch protocol-native wheel input on CDP and BiDi.
- Preserve the current profile-based chunking, pauses, and small correction behavior.
- Include e2e coverage for page scrolling, nested scroll containers, offscreen targets, blocked
  wheel events, and CDP/BiDi parity.
