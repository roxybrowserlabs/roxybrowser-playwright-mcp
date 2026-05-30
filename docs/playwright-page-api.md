  Page | Playwright

# Page

Page provides methods to interact with a single tab in a [Browser](/docs/api/class-browser "Browser"), or an [extension background page](https://developer.chrome.com/extensions/background_pages) in Chromium. One [Browser](/docs/api/class-browser "Browser") instance might have multiple [Page](/docs/api/class-page "Page") instances.

This example creates a page, navigates it to a URL, and then saves a screenshot:

```js
const { webkit } = require('playwright');  // Or 'chromium' or 'firefox'.(async () => {  const browser = await webkit.launch();  const context = await browser.newContext();  const page = await context.newPage();  await page.goto('https://example.com');  await page.screenshot({ path: 'screenshot.png' });  await browser.close();})();
```

The Page class emits various events (described below) which can be handled using any of Node's native [`EventEmitter`](https://nodejs.org/api/events.html#events_class_eventemitter) methods, such as `on`, `once` or `removeListener`.

This example logs a message for a single page `load` event:

```js
page.once('load', () => console.log('Page loaded!'));
```

To unsubscribe from events use the `removeListener` method:

```js
function logRequest(interceptedRequest) {  console.log('A request was made:', interceptedRequest.url());}page.on('request', logRequest);// Sometime later...page.removeListener('request', logRequest);
```

* * *

## Methods[​](#methods "Direct link to Methods")

### addInitScript[​](#page-add-init-script "Direct link to addInitScript")

Added before v1.9 page.addInitScript

Adds a script which would be evaluated in one of the following scenarios:

+   Whenever the page is navigated.
+   Whenever the child frame is attached or navigated. In this case, the script is evaluated in the context of the newly attached frame.

The script is evaluated after the document was created but before any of its scripts were run. This is useful to amend the JavaScript environment, e.g. to seed `Math.random`.

**Usage**

An example of overriding `Math.random` before the page loads:

```js
// preload.jsMath.random = () => 42;
```

```js
// In your playwright script, assuming the preload.js file is in same directoryawait page.addInitScript({ path: './preload.js' });
```

```js
await page.addInitScript(mock => {  window.mock = mock;}, mock);
```

note

The order of evaluation of multiple scripts installed via [browserContext.addInitScript()](/docs/api/class-browsercontext#browser-context-add-init-script) and [page.addInitScript()](/docs/api/class-page#page-add-init-script) is not defined.

**Arguments**

+   `script` [function](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Function "Function") | [string](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Data_structures#String_type "string") | [Object](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object "Object")[#](#page-add-init-script-option-script)
    
    +   `path` [string](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Data_structures#String_type "string") *(optional)*
        
        Path to the JavaScript file. If `path` is a relative path, then it is resolved relative to the current working directory. Optional.
        
    +   `content` [string](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Data_structures#String_type "string") *(optional)*
        
        Raw script content. Optional.
        
    
    Script to be evaluated in the page.
    
+   `arg` [Serializable](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/JSON/stringify#Description "Serializable") *(optional)*[#](#page-add-init-script-option-arg)
    
    Optional argument to pass to [script](/docs/api/class-page#page-add-init-script-option-script) (only supported when passing a function).
    

**Returns**

+   [Promise](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise "Promise")<[Disposable](/docs/api/class-disposable "Disposable")\>[#](#page-add-init-script-return)

* * *

### addLocatorHandler[​](#page-add-locator-handler "Direct link to addLocatorHandler")

Added in: v1.42 page.addLocatorHandler

When testing a web page, sometimes unexpected overlays like a "Sign up" dialog appear and block actions you want to automate, e.g. clicking a button. These overlays don't always show up in the same way or at the same time, making them tricky to handle in automated tests.

This method lets you set up a special function, called a handler, that activates when it detects that overlay is visible. The handler's job is to remove the overlay, allowing your test to continue as if the overlay wasn't there.

Things to keep in mind:

+   When an overlay is shown predictably, we recommend explicitly waiting for it in your test and dismissing it as a part of your normal test flow, instead of using [page.addLocatorHandler()](/docs/api/class-page#page-add-locator-handler).
+   Playwright checks for the overlay every time before executing or retrying an action that requires an [actionability check](/docs/actionability), or before performing an auto-waiting assertion check. When overlay is visible, Playwright calls the handler first, and then proceeds with the action/assertion. Note that the handler is only called when you perform an action/assertion - if the overlay becomes visible but you don't perform any actions, the handler will not be triggered.
+   After executing the handler, Playwright will ensure that overlay that triggered the handler is not visible anymore. You can opt-out of this behavior with [noWaitAfter](/docs/api/class-page#page-add-locator-handler-option-no-wait-after).
+   The execution time of the handler counts towards the timeout of the action/assertion that executed the handler. If your handler takes too long, it might cause timeouts.
+   You can register multiple handlers. However, only a single handler will be running at a time. Make sure the actions within a handler don't depend on another handler.

warning

Running the handler will alter your page state mid-test. For example it will change the currently focused element and move the mouse. Make sure that actions that run after the handler are self-contained and do not rely on the focus and mouse state being unchanged.

For example, consider a test that calls [locator.focus()](/docs/api/class-locator#locator-focus) followed by [keyboard.press()](/docs/api/class-keyboard#keyboard-press). If your handler clicks a button between these two actions, the focused element most likely will be wrong, and key press will happen on the unexpected element. Use [locator.press()](/docs/api/class-locator#locator-press) instead to avoid this problem.

Another example is a series of mouse actions, where [mouse.move()](/docs/api/class-mouse#mouse-move) is followed by [mouse.down()](/docs/api/class-mouse#mouse-down). Again, when the handler runs between these two actions, the mouse position will be wrong during the mouse down. Prefer self-contained actions like [locator.click()](/docs/api/class-locator#locator-click) that do not rely on the state being unchanged by a handler.

**Usage**

An example that closes a "Sign up to the newsletter" dialog when it appears:

```js
// Setup the handler.await page.addLocatorHandler(page.getByText('Sign up to the newsletter'), async () => {  await page.getByRole('button', { name: 'No thanks' }).click();});// Write the test as usual.await page.goto('https://example.com');await page.getByRole('button', { name: 'Start here' }).click();
```

An example that skips the "Confirm your security details" page when it is shown:

```js
// Setup the handler.await page.addLocatorHandler(page.getByText('Confirm your security details'), async () => {  await page.getByRole('button', { name: 'Remind me later' }).click();});// Write the test as usual.await page.goto('https://example.com');await page.getByRole('button', { name: 'Start here' }).click();
```

An example with a custom callback on every actionability check. It uses a `<body>` locator that is always visible, so the handler is called before every actionability check. It is important to specify [noWaitAfter](/docs/api/class-page#page-add-locator-handler-option-no-wait-after), because the handler does not hide the `<body>` element.

```js
// Setup the handler.await page.addLocatorHandler(page.locator('body'), async () => {  await page.evaluate(() => window.removeObstructionsForTestIfNeeded());}, { noWaitAfter: true });// Write the test as usual.await page.goto('https://example.com');await page.getByRole('button', { name: 'Start here' }).click();
```

Handler takes the original locator as an argument. You can also automatically remove the handler after a number of invocations by setting [times](/docs/api/class-page#page-add-locator-handler-option-times):

```js
await page.addLocatorHandler(page.getByLabel('Close'), async locator => {  await locator.click();}, { times: 1 });
```

**Arguments**

+   `locator` [Locator](/docs/api/class-locator "Locator")[#](#page-add-locator-handler-option-locator)
    
    Locator that triggers the handler.
    
+   `handler` [function](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Function "Function")([Locator](/docs/api/class-locator "Locator")):[Promise](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise "Promise")<[Object](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object "Object")\>[#](#page-add-locator-handler-option-handler)
    
    Function that should be run once [locator](/docs/api/class-page#page-add-locator-handler-option-locator) appears. This function should get rid of the element that blocks actions like click.
    
+   `options` [Object](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object "Object") *(optional)*
    
    +   `noWaitAfter` [boolean](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Data_structures#Boolean_type "Boolean") *(optional)* Added in: v1.44[#](#page-add-locator-handler-option-no-wait-after)
        
        By default, after calling the handler Playwright will wait until the overlay becomes hidden, and only then Playwright will continue with the action/assertion that triggered the handler. This option allows to opt-out of this behavior, so that overlay can stay visible after the handler has run.
        
    +   `times` [number](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Data_structures#Number_type "Number") *(optional)* Added in: v1.44[#](#page-add-locator-handler-option-times)
        
        Specifies the maximum number of times this handler should be called. Unlimited by default.
        

**Returns**

+   [Promise](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise "Promise")<[void](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/undefined "void")\>[#](#page-add-locator-handler-return)

* * *

### addScriptTag[​](#page-add-script-tag "Direct link to addScriptTag")

Added before v1.9 page.addScriptTag

Adds a `<script>` tag into the page with the desired url or content. Returns the added tag when the script's onload fires or when the script content was injected into frame.

**Usage**

```js
await page.addScriptTag();await page.addScriptTag(options);
```

**Arguments**

+   `options` [Object](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object "Object") *(optional)*
    +   `content` [string](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Data_structures#String_type "string") *(optional)*[#](#page-add-script-tag-option-content)
        
        Raw JavaScript content to be injected into frame.
        
    +   `path` [string](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Data_structures#String_type "string") *(optional)*[#](#page-add-script-tag-option-path)
        
        Path to the JavaScript file to be injected into frame. If `path` is a relative path, then it is resolved relative to the current working directory.
        
    +   `type` [string](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Data_structures#String_type "string") *(optional)*[#](#page-add-script-tag-option-type)
        
        Script type. Use 'module' in order to load a JavaScript ES6 module. See [script](https://developer.mozilla.org/en-US/docs/Web/HTML/Element/script) for more details.
        
    +   `url` [string](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Data_structures#String_type "string") *(optional)*[#](#page-add-script-tag-option-url)
        
        URL of a script to be added.
        

**Returns**

+   [Promise](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise "Promise")<[ElementHandle](/docs/api/class-elementhandle "ElementHandle")\>[#](#page-add-script-tag-return)

* * *

### addStyleTag[​](#page-add-style-tag "Direct link to addStyleTag")

Added before v1.9 page.addStyleTag

Adds a `<link rel="stylesheet">` tag into the page with the desired url or a `<style type="text/css">` tag with the content. Returns the added tag when the stylesheet's onload fires or when the CSS content was injected into frame.

**Usage**

```js
await page.addStyleTag();await page.addStyleTag(options);
```

**Arguments**

+   `options` [Object](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object "Object") *(optional)*
    +   `content` [string](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Data_structures#String_type "string") *(optional)*[#](#page-add-style-tag-option-content)
        
        Raw CSS content to be injected into frame.
        
    +   `path` [string](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Data_structures#String_type "string") *(optional)*[#](#page-add-style-tag-option-path)
        
        Path to the CSS file to be injected into frame. If `path` is a relative path, then it is resolved relative to the current working directory.
        
    +   `url` [string](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Data_structures#String_type "string") *(optional)*[#](#page-add-style-tag-option-url)
        
        URL of the `<link>` tag.
        

**Returns**

+   [Promise](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise "Promise")<[ElementHandle](/docs/api/class-elementhandle "ElementHandle")\>[#](#page-add-style-tag-return)

* * *

### ariaSnapshot[​](#page-aria-snapshot "Direct link to ariaSnapshot")

Added in: v1.59 page.ariaSnapshot

Captures the aria snapshot of the page. Read more about [aria snapshots](/docs/aria-snapshots).

**Usage**

```js
await page.ariaSnapshot();await page.ariaSnapshot(options);
```

**Arguments**

+   `options` [Object](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object "Object") *(optional)*
    +   `boxes` [boolean](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Data_structures#Boolean_type "Boolean") *(optional)* Added in: v1.60[#](#page-aria-snapshot-option-boxes)
        
        When `true`, appends each element's bounding box as `[box=x,y,width,height]` to the snapshot. Coordinates are relative to the viewport, in CSS pixels, as returned by [`Element.getBoundingClientRect()`](https://developer.mozilla.org/en-US/docs/Web/API/Element/getBoundingClientRect). Defaults to `false`.
        
    +   `depth` [number](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Data_structures#Number_type "Number") *(optional)*[#](#page-aria-snapshot-option-depth)
        
        When specified, limits the depth of the snapshot.
        
    +   `mode` "ai" | "default" *(optional)*[#](#page-aria-snapshot-option-mode)
        
        When set to `"ai"`, returns a snapshot optimized for AI consumption: including element references like `[ref=e2]` and snapshots of `<iframe>`s. Defaults to `"default"`.
        
    +   `timeout` [number](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Data_structures#Number_type "Number") *(optional)*[#](#page-aria-snapshot-option-timeout)
        
        Maximum time in milliseconds. Defaults to `0` - no timeout. The default value can be changed via `actionTimeout` option in the config, or by using the [browserContext.setDefaultTimeout()](/docs/api/class-browsercontext#browser-context-set-default-timeout) or [page.setDefaultTimeout()](/docs/api/class-page#page-set-default-timeout) methods.
        

**Returns**

+   [Promise](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise "Promise")<[string](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Data_structures#String_type "string")\>[#](#page-aria-snapshot-return)

* * *

### bringToFront[​](#page-bring-to-front "Direct link to bringToFront")

Added before v1.9 page.bringToFront

Brings page to front (activates tab).

**Usage**

```js
await page.bringToFront();
```

**Returns**

+   [Promise](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise "Promise")<[void](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/undefined "void")\>[#](#page-bring-to-front-return)

* * *

### cancelPickLocator[​](#page-cancel-pick-locator "Direct link to cancelPickLocator")

Added in: v1.59 page.cancelPickLocator

Cancels an ongoing [page.pickLocator()](/docs/api/class-page#page-pick-locator) call by deactivating pick locator mode. If no pick locator mode is active, this method is a no-op.

**Usage**

```js
await page.cancelPickLocator();
```

**Returns**

+   [Promise](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise "Promise")<[void](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/undefined "void")\>[#](#page-cancel-pick-locator-return)

* * *

### clearConsoleMessages[​](#page-clear-console-messages "Direct link to clearConsoleMessages")

Added in: v1.59 page.clearConsoleMessages

Clears all stored console messages from this page. Subsequent calls to [page.consoleMessages()](/docs/api/class-page#page-console-messages) will only return messages logged after the clear.

**Usage**

```js
await page.clearConsoleMessages();
```

**Returns**

+   [Promise](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise "Promise")<[void](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/undefined "void")\>[#](#page-clear-console-messages-return)

* * *

### clearPageErrors[​](#page-clear-page-errors "Direct link to clearPageErrors")

Added in: v1.59 page.clearPageErrors

Clears all stored page errors from this page. Subsequent calls to [page.pageErrors()](/docs/api/class-page#page-page-errors) will only return errors thrown after the clear.

**Usage**

```js
await page.clearPageErrors();
```

**Returns**

+   [Promise](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise "Promise")<[void](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/undefined "void")\>[#](#page-clear-page-errors-return)

* * *

### close[​](#page-close "Direct link to close")

Added before v1.9 page.close

If [runBeforeUnload](/docs/api/class-page#page-close-option-run-before-unload) is `false`, does not run any unload handlers and waits for the page to be closed. If [runBeforeUnload](/docs/api/class-page#page-close-option-run-before-unload) is `true` the method will run unload handlers, but will **not** wait for the page to close.

By default, `page.close()` **does not** run `beforeunload` handlers.

note

if [runBeforeUnload](/docs/api/class-page#page-close-option-run-before-unload) is passed as true, a `beforeunload` dialog might be summoned and should be handled manually via [page.on('dialog')](/docs/api/class-page#page-event-dialog) event.

**Usage**

```js
await page.close();await page.close(options);
```

**Arguments**

+   `options` [Object](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object "Object") *(optional)*
    +   `reason` [string](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Data_structures#String_type "string") *(optional)* Added in: v1.40[#](#page-close-option-reason)
        
        The reason to be reported to the operations interrupted by the page closure.
        
    +   `runBeforeUnload` [boolean](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Data_structures#Boolean_type "Boolean") *(optional)*[#](#page-close-option-run-before-unload)
        
        Defaults to `false`. Whether to run the [before unload](https://developer.mozilla.org/en-US/docs/Web/Events/beforeunload) page handlers.
        

**Returns**

+   [Promise](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise "Promise")<[void](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/undefined "void")\>[#](#page-close-return)

* * *

### consoleMessages[​](#page-console-messages "Direct link to consoleMessages")

Added in: v1.56 page.consoleMessages

Returns up to (currently) 200 last console messages from this page. See [page.on('console')](/docs/api/class-page#page-event-console) for more details.

**Usage**

```js
await page.consoleMessages();await page.consoleMessages(options);
```

**Arguments**

+   `options` [Object](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object "Object") *(optional)*
    +   `filter` "all" | "since-navigation" *(optional)* Added in: v1.59[#](#page-console-messages-option-filter)
        
        Controls which messages are returned:
        

**Returns**

+   [Promise](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise "Promise")<[Array](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array "Array")<[ConsoleMessage](/docs/api/class-consolemessage "ConsoleMessage")\>>[#](#page-console-messages-return)

* * *

### content[​](#page-content "Direct link to content")

Added before v1.9 page.content

Gets the full HTML contents of the page, including the doctype.

**Usage**

```js
await page.content();
```

**Returns**

+   [Promise](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise "Promise")<[string](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Data_structures#String_type "string")\>[#](#page-content-return)

* * *

### context[​](#page-context "Direct link to context")

Added before v1.9 page.context

Get the browser context that the page belongs to.

**Usage**

```js
page.context();
```

**Returns**

+   [BrowserContext](/docs/api/class-browsercontext "BrowserContext")[#](#page-context-return)

* * *

### dragAndDrop[​](#page-drag-and-drop "Direct link to dragAndDrop")

Added in: v1.13 page.dragAndDrop

This method drags the source element to the target element. It will first move to the source element, perform a `mousedown`, then move to the target element and perform a `mouseup`.

**Usage**

```js
await page.dragAndDrop('#source', '#target');// or specify exact positions relative to the top-left corners of the elements:await page.dragAndDrop('#source', '#target', {  sourcePosition: { x: 34, y: 7 },  targetPosition: { x: 10, y: 20 },});
```

**Arguments**

+   `source` [string](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Data_structures#String_type "string")[#](#page-drag-and-drop-option-source)
    
    A selector to search for an element to drag. If there are multiple elements satisfying the selector, the first will be used.
    
+   `target` [string](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Data_structures#String_type "string")[#](#page-drag-and-drop-option-target)
    
    A selector to search for an element to drop onto. If there are multiple elements satisfying the selector, the first will be used.
    
+   `options` [Object](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object "Object") *(optional)*
    
    +   `force` [boolean](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Data_structures#Boolean_type "Boolean") *(optional)*[#](#page-drag-and-drop-option-force)
        
        Whether to bypass the [actionability](/docs/actionability) checks. Defaults to `false`.
        
    +   `noWaitAfter` [boolean](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Data_structures#Boolean_type "Boolean") *(optional)*[#](#page-drag-and-drop-option-no-wait-after)
        
        Deprecated
        
        This option has no effect.
        
        This option has no effect.
        
    +   `sourcePosition` [Object](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object "Object") *(optional)* Added in: v1.14[#](#page-drag-and-drop-option-source-position)
        
        +   `x` [number](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Data_structures#Number_type "Number")
            
        +   `y` [number](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Data_structures#Number_type "Number")
            
        
        Clicks on the source element at this point relative to the top-left corner of the element's padding box. If not specified, some visible point of the element is used.
        
    +   `steps` [number](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Data_structures#Number_type "Number") *(optional)* Added in: v1.57[#](#page-drag-and-drop-option-steps)
        
        Defaults to 1. Sends `n` interpolated `mousemove` events to represent travel between the `mousedown` and `mouseup` of the drag. When set to 1, emits a single `mousemove` event at the destination location.
        
    +   `strict` [boolean](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Data_structures#Boolean_type "Boolean") *(optional)* Added in: v1.14[#](#page-drag-and-drop-option-strict)
        
        When true, the call requires selector to resolve to a single element. If given selector resolves to more than one element, the call throws an exception.
        
    +   `targetPosition` [Object](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object "Object") *(optional)* Added in: v1.14[#](#page-drag-and-drop-option-target-position)
        
        +   `x` [number](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Data_structures#Number_type "Number")
            
        +   `y` [number](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Data_structures#Number_type "Number")
            
        
        Drops on the target element at this point relative to the top-left corner of the element's padding box. If not specified, some visible point of the element is used.
        
    +   `timeout` [number](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Data_structures#Number_type "Number") *(optional)*[#](#page-drag-and-drop-option-timeout)
        
        Maximum time in milliseconds. Defaults to `0` - no timeout. The default value can be changed via `actionTimeout` option in the config, or by using the [browserContext.setDefaultTimeout()](/docs/api/class-browsercontext#browser-context-set-default-timeout) or [page.setDefaultTimeout()](/docs/api/class-page#page-set-default-timeout) methods.
        
    +   `trial` [boolean](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Data_structures#Boolean_type "Boolean") *(optional)*[#](#page-drag-and-drop-option-trial)
        
        When set, this method only performs the [actionability](/docs/actionability) checks and skips the action. Defaults to `false`. Useful to wait until the element is ready for the action without performing it.
        

**Returns**

+   [Promise](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise "Promise")<[void](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/undefined "void")\>[#](#page-drag-and-drop-return)

* * *

### emulateMedia[​](#page-emulate-media "Direct link to emulateMedia")

Added before v1.9 page.emulateMedia

This method changes the `CSS media type` through the `media` argument, and/or the `'prefers-colors-scheme'` media feature, using the `colorScheme` argument.

**Usage**

```js
await page.evaluate(() => matchMedia('screen').matches);// → trueawait page.evaluate(() => matchMedia('print').matches);// → falseawait page.emulateMedia({ media: 'print' });await page.evaluate(() => matchMedia('screen').matches);// → falseawait page.evaluate(() => matchMedia('print').matches);// → trueawait page.emulateMedia({});await page.evaluate(() => matchMedia('screen').matches);// → trueawait page.evaluate(() => matchMedia('print').matches);// → false
```

```js
await page.emulateMedia({ colorScheme: 'dark' });await page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches);// → trueawait page.evaluate(() => matchMedia('(prefers-color-scheme: light)').matches);// → false
```

**Arguments**

+   `options` [Object](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object "Object") *(optional)*
    +   `colorScheme` [null](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/null "null") | "light" | "dark" | "no-preference" *(optional)* Added in: v1.9[#](#page-emulate-media-option-color-scheme)
        
        Emulates [prefers-colors-scheme](https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-color-scheme) media feature, supported values are `'light'` and `'dark'`. Passing `null` disables color scheme emulation. `'no-preference'` is deprecated.
        
    +   `contrast` [null](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/null "null") | "no-preference" | "more" *(optional)* Added in: v1.51[#](#page-emulate-media-option-contrast)
        
        Emulates `'prefers-contrast'` media feature, supported values are `'no-preference'`, `'more'`. Passing `null` disables contrast emulation.
        
    +   `forcedColors` [null](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/null "null") | "active" | "none" *(optional)* Added in: v1.15[#](#page-emulate-media-option-forced-colors)
        
        Emulates `'forced-colors'` media feature, supported values are `'active'` and `'none'`. Passing `null` disables forced colors emulation.
        
    +   `media` [null](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/null "null") | "screen" | "print" *(optional)* Added in: v1.9[#](#page-emulate-media-option-media)
        
        Changes the CSS media type of the page. The only allowed values are `'screen'`, `'print'` and `null`. Passing `null` disables CSS media emulation.
        
    +   `reducedMotion` [null](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/null "null") | "reduce" | "no-preference" *(optional)* Added in: v1.12[#](#page-emulate-media-option-reduced-motion)
        
        Emulates `'prefers-reduced-motion'` media feature, supported values are `'reduce'`, `'no-preference'`. Passing `null` disables reduced motion emulation.
        

**Returns**

+   [Promise](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise "Promise")<[void](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/undefined "void")\>[#](#page-emulate-media-return)

* * *

### evaluate[​](#page-evaluate "Direct link to evaluate")

Added before v1.9 page.evaluate

Returns the value of the [pageFunction](/docs/api/class-page#page-evaluate-option-expression) invocation.

If the function passed to the [page.evaluate()](/docs/api/class-page#page-evaluate) returns a [Promise](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise "Promise"), then [page.evaluate()](/docs/api/class-page#page-evaluate) would wait for the promise to resolve and return its value.

If the function passed to the [page.evaluate()](/docs/api/class-page#page-evaluate) returns a non-[Serializable](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/JSON/stringify#Description "Serializable") value, then [page.evaluate()](/docs/api/class-page#page-evaluate) resolves to `undefined`. Playwright also supports transferring some additional values that are not serializable by `JSON`: `-0`, `NaN`, `Infinity`, `-Infinity`.

**Usage**

Passing argument to [pageFunction](/docs/api/class-page#page-evaluate-option-expression):

```js
const result = await page.evaluate(([x, y]) => {  return Promise.resolve(x * y);}, [7, 8]);console.log(result); // prints "56"
```

A string can also be passed in instead of a function:

```js
console.log(await page.evaluate('1 + 2')); // prints "3"const x = 10;console.log(await page.evaluate(`1 + ${x}`)); // prints "11"
```

[ElementHandle](/docs/api/class-elementhandle "ElementHandle") instances can be passed as an argument to the [page.evaluate()](/docs/api/class-page#page-evaluate):

```js
const bodyHandle = await page.evaluate('document.body');const html = await page.evaluate<string, HTMLElement>(([body, suffix]) =>  body.innerHTML + suffix, [bodyHandle, 'hello']);await bodyHandle.dispose();
```

**Arguments**

+   `pageFunction` [function](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Function "Function") | [string](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Data_structures#String_type "string")[#](#page-evaluate-option-expression)
    
    Function to be evaluated in the page context.
    
+   `arg` [EvaluationArgument](/docs/evaluating#evaluation-argument "EvaluationArgument") *(optional)*[#](#page-evaluate-option-arg)
    
    Optional argument to pass to [pageFunction](/docs/api/class-page#page-evaluate-option-expression).
    

**Returns**

+   [Promise](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise "Promise")<[Serializable](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/JSON/stringify#Description "Serializable")\>[#](#page-evaluate-return)

* * *

### evaluateHandle[​](#page-evaluate-handle "Direct link to evaluateHandle")

Added before v1.9 page.evaluateHandle

Returns the value of the [pageFunction](/docs/api/class-page#page-evaluate-handle-option-expression) invocation as a [JSHandle](/docs/api/class-jshandle "JSHandle").

The only difference between [page.evaluate()](/docs/api/class-page#page-evaluate) and [page.evaluateHandle()](/docs/api/class-page#page-evaluate-handle) is that [page.evaluateHandle()](/docs/api/class-page#page-evaluate-handle) returns [JSHandle](/docs/api/class-jshandle "JSHandle").

If the function passed to the [page.evaluateHandle()](/docs/api/class-page#page-evaluate-handle) returns a [Promise](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise "Promise"), then [page.evaluateHandle()](/docs/api/class-page#page-evaluate-handle) would wait for the promise to resolve and return its value.

**Usage**

```js
// Handle for the window object.const aWindowHandle = await page.evaluateHandle(() => Promise.resolve(window));
```

A string can also be passed in instead of a function:

```js
const aHandle = await page.evaluateHandle('document'); // Handle for the 'document'
```

[JSHandle](/docs/api/class-jshandle "JSHandle") instances can be passed as an argument to the [page.evaluateHandle()](/docs/api/class-page#page-evaluate-handle):

```js
const aHandle = await page.evaluateHandle(() => document.body);const resultHandle = await page.evaluateHandle(body => body.innerHTML, aHandle);console.log(await resultHandle.jsonValue());await resultHandle.dispose();
```

**Arguments**

+   `pageFunction` [function](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Function "Function") | [string](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Data_structures#String_type "string")[#](#page-evaluate-handle-option-expression)
    
    Function to be evaluated in the page context.
    
+   `arg` [EvaluationArgument](/docs/evaluating#evaluation-argument "EvaluationArgument") *(optional)*[#](#page-evaluate-handle-option-arg)
    
    Optional argument to pass to [pageFunction](/docs/api/class-page#page-evaluate-handle-option-expression).
    

**Returns**

+   [Promise](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise "Promise")<[JSHandle](/docs/api/class-jshandle "JSHandle")\>[#](#page-evaluate-handle-return)

* * *

### exposeBinding[​](#page-expose-binding "Direct link to exposeBinding")

Added before v1.9 page.exposeBinding

The method adds a function called [name](/docs/api/class-page#page-expose-binding-option-name) on the `window` object of every frame in this page. When called, the function executes [callback](/docs/api/class-page#page-expose-binding-option-callback) and returns a [Promise](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise "Promise") which resolves to the return value of [callback](/docs/api/class-page#page-expose-binding-option-callback). If the [callback](/docs/api/class-page#page-expose-binding-option-callback) returns a [Promise](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise "Promise"), it will be awaited.

The first argument of the [callback](/docs/api/class-page#page-expose-binding-option-callback) function contains information about the caller: `{ browserContext: BrowserContext, page: Page, frame: Frame }`.

See [browserContext.exposeBinding()](/docs/api/class-browsercontext#browser-context-expose-binding) for the context-wide version.

note

Functions installed via [page.exposeBinding()](/docs/api/class-page#page-expose-binding) survive navigations.

**Usage**

An example of exposing page URL to all frames in a page:

```js
const { webkit } = require('playwright');  // Or 'chromium' or 'firefox'.(async () => {  const browser = await webkit.launch({ headless: false });  const context = await browser.newContext();  const page = await context.newPage();  await page.exposeBinding('pageURL', ({ page }) => page.url());  await page.setContent(`    <script>      async function onClick() {        document.querySelector('div').textContent = await window.pageURL();      }    </script>    <button onclick="onClick()">Click me</button>    <div></div>  `);  await page.click('button');})();
```

**Arguments**

+   `name` [string](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Data_structures#String_type "string")[#](#page-expose-binding-option-name)
    
    Name of the function on the window object.
    
+   `callback` [function](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Function "Function")[#](#page-expose-binding-option-callback)
    
    Callback function that will be called in the Playwright's context.
    

**Returns**

+   [Promise](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise "Promise")<[Disposable](/docs/api/class-disposable "Disposable")\>[#](#page-expose-binding-return)

* * *

### exposeFunction[​](#page-expose-function "Direct link to exposeFunction")

Added before v1.9 page.exposeFunction

The method adds a function called [name](/docs/api/class-page#page-expose-function-option-name) on the `window` object of every frame in the page. When called, the function executes [callback](/docs/api/class-page#page-expose-function-option-callback) and returns a [Promise](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise "Promise") which resolves to the return value of [callback](/docs/api/class-page#page-expose-function-option-callback).

If the [callback](/docs/api/class-page#page-expose-function-option-callback) returns a [Promise](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise "Promise"), it will be awaited.

See [browserContext.exposeFunction()](/docs/api/class-browsercontext#browser-context-expose-function) for context-wide exposed function.

note

Functions installed via [page.exposeFunction()](/docs/api/class-page#page-expose-function) survive navigations.

**Usage**

An example of adding a `sha256` function to the page:

```js
const { webkit } = require('playwright');  // Or 'chromium' or 'firefox'.const crypto = require('crypto');(async () => {  const browser = await webkit.launch({ headless: false });  const page = 


```