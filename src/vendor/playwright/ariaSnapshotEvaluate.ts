/**
 * Playwright browser_snapshot evaluate wrapper.
 *
 * The injected snapshot implementation is vendored from Microsoft Playwright
 * at commit e8e8d69569de6ad8885b50664bdfd0dc3e8315ed (Apache-2.0).
 * This wrapper intentionally does not import Playwright at runtime.
 */
import { PLAYWRIGHT_INJECTED_SCRIPT_SOURCE } from "./generated/injectedScriptSource.js";

export const PLAYWRIGHT_ARIA_SNAPSHOT_EVALUATE_SOURCE = `(payload) => {
  const options = payload && payload.options ? payload.options : {};
  const target = payload && payload.target ? payload.target : undefined;
  const testIdAttribute = payload && typeof payload.testIdAttribute === "string" && payload.testIdAttribute
    ? payload.testIdAttribute
    : "data-testid";
  const rootDocument = document;
  if (!rootDocument.body || rootDocument.readyState === "loading") {
    return {
      notReady: true,
      refs: {},
      text: "",
      title: String(rootDocument.title || ""),
      url: String(globalThis.location && globalThis.location.href || "")
    };
  }

  const previousState = globalThis.__roxyMcpState && globalThis.__roxyMcpState.elements
    ? globalThis.__roxyMcpState
    : { elements: new Map(), refs: new Map(), nextFrameSeq: 1 };

  function resolveRootNode() {
    if (!target) {
      return { ok: true, node: rootDocument.body };
    }

    if (target.nodeToken) {
      const element = previousState.elements.get(target.nodeToken);
      if (!element || !element.isConnected) {
        return { ok: false, error: { code: "stale" } };
      }
      return { ok: true, node: element };
    }

    if (target.handleId) {
      const scopes = [];
      try {
        if (globalThis.top) {
          scopes.push(globalThis.top);
        }
      } catch {}
      scopes.push(globalThis);
      for (const scope of scopes) {
        const store = scope && scope.__roxyHandleStore;
        const element = store && store[target.handleId];
        if (element && element.isConnected) {
          return { ok: true, node: element };
        }
      }
      return { ok: false, error: { code: "stale" } };
    }

    const selector = target.selector || target.raw;
    if (!selector) {
      return { ok: false, error: { code: "not_found" } };
    }

    let element = null;
    try {
      element = rootDocument.querySelector(selector);
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "invalid_selector",
          message: error && error.message ? String(error.message) : undefined
        }
      };
    }

    if (!element) {
      return { ok: false, error: { code: "not_found" } };
    }
    return { ok: true, node: element };
  }

  const resolvedRoot = resolveRootNode();
  if (!resolvedRoot.ok) {
    return {
      refs: {},
      text: "",
      title: String(rootDocument.title || ""),
      url: String(globalThis.location && globalThis.location.href || ""),
      error: resolvedRoot.error
    };
  }

  if (!globalThis.__roxyPlaywrightSnapshotBundle) {
${PLAYWRIGHT_INJECTED_SCRIPT_SOURCE
  .split("\n")
  .map((line) => `    ${line}`)
  .join("\n")}
  }
  const snapshotBundle = globalThis.__roxyPlaywrightSnapshotBundle;
  if (!snapshotBundle || !snapshotBundle.InjectedScript) {
    throw new Error("Playwright snapshot injected bundle did not expose InjectedScript.");
  }

  const injected = globalThis.__roxyPlaywrightInjectedScript
    && globalThis.__roxyPlaywrightInjectedScriptTestIdAttribute === testIdAttribute
      ? globalThis.__roxyPlaywrightInjectedScript
      : new snapshotBundle.InjectedScript(globalThis, {
        isUnderTest: false,
        sdkLanguage: "javascript",
        testIdAttributeName: testIdAttribute,
        stableRafCount: 1,
        browserName: "chromium",
        shouldPrependErrorPrefix: false,
        isUtilityWorld: true,
        customEngines: []
      });
  globalThis.__roxyPlaywrightInjectedScript = injected;
  globalThis.__roxyPlaywrightInjectedScriptTestIdAttribute = testIdAttribute;

  const mcpState = {
    refs: new Map(),
    elements: new Map(),
    locators: new Map(),
    nextFrameSeq: typeof previousState.nextFrameSeq === "number" ? previousState.nextFrameSeq : 1
  };

  function jsString(value) {
    const stringified = JSON.stringify(String(value));
    return "'" + stringified.substring(1, stringified.length - 1).replace(/\\\\?"/g, '"').replace(/'/g, "\\\\'") + "'";
  }

  function testIdLocatorForElement(element) {
    for (const attribute of testIdAttribute.split(",")) {
      const testId = element.getAttribute && element.getAttribute(attribute);
      if (testId !== null && testId !== undefined) {
        return "getByTestId(" + jsString(testId) + ")";
      }
    }
    return undefined;
  }

  function rememberSnapshotElements(snapshotElements) {
    for (const entry of snapshotElements.entries()) {
      const ref = entry[0];
      const element = entry[1];
      mcpState.refs.set(ref, ref);
      mcpState.elements.set(ref, element);
      try {
        const locator = testIdLocatorForElement(element);
        if (locator) {
          mcpState.locators.set(ref, locator);
        }
      } catch {}
    }
  }

  function captureSnapshot(node, snapshotOptions) {
    const snapshot = injected.incrementalAriaSnapshot(node, snapshotOptions);
    const lastSnapshot = injected._lastAriaSnapshotForQuery;
    const snapshotElements = new Map();
    if (lastSnapshot && lastSnapshot.info) {
      for (const entry of lastSnapshot.info.entries()) {
        snapshotElements.set(entry[0], entry[1].element);
      }
    } else if (lastSnapshot && lastSnapshot.elements) {
      for (const entry of lastSnapshot.elements.entries()) {
        snapshotElements.set(entry[0], entry[1]);
      }
    }
    rememberSnapshotElements(snapshotElements);
    return { elements: snapshotElements, snapshot };
  }

  function ensureFrameSeq(iframeElement) {
    if (typeof iframeElement.__roxyFrameSeq !== "number") {
      iframeElement.__roxyFrameSeq = mcpState.nextFrameSeq++;
    }
    return iframeElement.__roxyFrameSeq;
  }

  function stitchCapture(capture, snapshotOptions) {
    const renderedIframeRefs = (capture.snapshot.iframeRefs || []).filter(
      (ref) => ref in (capture.snapshot.iframeDepths || {})
    );

    const childSnapshots = renderedIframeRefs.map((ref) => {
      const iframeElement = capture.elements.get(ref);
      if (!iframeElement) {
        return { full: [] };
      }

      let frameRoot = null;
      try {
        const frameDocument = iframeElement.contentDocument;
        frameRoot = frameDocument && (frameDocument.body || frameDocument.documentElement);
      } catch {}

      if (!frameRoot) {
        return { full: [] };
      }

      const iframeDepth = capture.snapshot.iframeDepths[ref];
      const childDepth =
        typeof snapshotOptions.depth === "number"
          ? snapshotOptions.depth - iframeDepth - 1
          : undefined;
      const frameSeq = ensureFrameSeq(iframeElement);
      const childCapture = captureSnapshot(frameRoot, {
        ...snapshotOptions,
        depth: childDepth,
        refPrefix: "f" + frameSeq
      });
      return stitchCapture(childCapture, {
        ...snapshotOptions,
        depth: childDepth
      });
    });

    const full = [];
    const lines = String(capture.snapshot.full || "").split("\\n");
    for (const line of lines) {
      const match = line.match(/^(\\s*)- iframe (?:\\[active\\] )?\\[ref=([^\\]]*)\\]/);
      if (!match) {
        if (line) {
          full.push(line);
        }
        continue;
      }

      const leadingSpace = match[1];
      const ref = match[2];
      const childSnapshot = childSnapshots[renderedIframeRefs.indexOf(ref)] || { full: [] };
      full.push(childSnapshot.full.length ? line + ":" : line);
      full.push(...childSnapshot.full.map((entry) => leadingSpace + "  " + entry));
    }

    return { full };
  }

  const baseSnapshotOptions = {
    mode: options.mode || "default",
    refPrefix: "",
    doNotRenderActive: options.doNotRenderActive,
    depth: options.depth,
    boxes: options.boxes
  };
  const rootCapture = captureSnapshot(resolvedRoot.node, baseSnapshotOptions);
  const stitched = stitchCapture(rootCapture, baseSnapshotOptions);

  globalThis.__roxyMcpState = mcpState;

  return {
    refs: Object.fromEntries(mcpState.refs.entries()),
    locators: Object.fromEntries(mcpState.locators.entries()),
    text: stitched.full.join("\\n"),
    title: String(rootDocument.title || ""),
    url: String(globalThis.location && globalThis.location.href || "")
  };
}`;
