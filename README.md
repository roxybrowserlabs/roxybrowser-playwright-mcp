# @roxybrowser/playwright

`@roxybrowser/playwright` is a Playwright-style automation library with humanized behavior by default.

## Design goals

- Keep the public API familiar to Playwright users.
- Route all browser operations through a protocol-agnostic adapter layer.
- Start with `chrome-remote-interface` over CDP.
- Reserve clean extension points for future BiDi and WebDriver backends.
- Make click, type, hover, and scroll behavior humanized by default instead of adding a second API.

## Package layout

- `src/browser*.ts`: public browser, context, and browser type objects.
- `src/page.ts` and `src/locator.ts`: Playwright-style page and locator APIs.
- `src/protocol/*`: protocol abstraction plus CDP and BiDi backend entry points.
- `src/protocol/webdriver/*`: WebDriver bootstrap placeholder for future BiDi session orchestration.
- `src/human/*`: humanization profiles and controller contracts.
- `docs/architecture.md`: detailed architecture notes and implementation plan.

## Current state

This branch establishes the package scaffold, API shape, and protocol boundaries. The CDP runtime is intentionally skeletal so the architecture can be reviewed before we lock implementation details.
