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
    : { elements: new Map(), refs: new Map() };

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

  const injected = globalThis.__roxyPlaywrightInjectedScript || new snapshotBundle.InjectedScript(globalThis, {
    isUnderTest: false,
    sdkLanguage: "javascript",
    testIdAttributeName: "data-testid",
    stableRafCount: 1,
    browserName: "chromium",
    shouldPrependErrorPrefix: false,
    isUtilityWorld: true,
    customEngines: []
  });
  globalThis.__roxyPlaywrightInjectedScript = injected;

  const snapshot = injected.incrementalAriaSnapshot(resolvedRoot.node, {
    mode: options.mode || "default",
    refPrefix: "",
    doNotRenderActive: options.doNotRenderActive,
    depth: options.depth,
    boxes: options.boxes
  });

  const refs = new Map();
  const elements = new Map();
  const snapshotElements = injected._lastAriaSnapshotForQuery && injected._lastAriaSnapshotForQuery.elements
    ? injected._lastAriaSnapshotForQuery.elements
    : new Map();
  for (const entry of snapshotElements.entries()) {
    const ref = entry[0];
    const element = entry[1];
    refs.set(ref, ref);
    elements.set(ref, element);
  }

  globalThis.__roxyMcpState = { refs, elements };

  return {
    refs: Object.fromEntries(refs.entries()),
    text: snapshot.full,
    title: String(rootDocument.title || ""),
    url: String(globalThis.location && globalThis.location.href || "")
  };
}`;
