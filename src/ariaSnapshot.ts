import { TimeoutError } from "./errors.js";
import type { AriaSnapshotOptions } from "./types/options.js";

export interface AriaSnapshotResult {
  refs: Record<string, string>;
  text: string;
  title: string;
  url: string;
}

export interface ResolvedAriaRefResult {
  ok: boolean;
  reason?: "stale";
  ref?: string;
  selector?: string | null;
  xpath?: string | null;
  querySelector?: string | null;
  querySelectorChain?: string | null;
  framePath?: Array<{
    selector: string | null;
    xpath: string | null;
  }>;
  inShadowTree?: boolean;
}

export const ARIA_SNAPSHOT_EVALUATE_SOURCE = String.raw`(payload) => {
  const options = payload && payload.options ? payload.options : {};
  const maxDepth = typeof options.depth === "number" ? options.depth : undefined;
  const includeBoxes = Boolean(options.boxes);
  const mode = options.mode === "ai" ? "ai" : "default";
  const rootDocument = document;
  const globalState = globalThis.__roxyMcpState ?? {
    elements: new Map(),
    refs: new Map(),
    nextRefId: 1,
    nextNodeId: 1
  };
  globalState.elements = new Map();
  globalState.refs = new Map();
  globalState.nextRefId = 1;
  globalState.nextNodeId = 1;
  globalThis.__roxyMcpState = globalState;

  const interactiveRoles = new Set([
    "button",
    "checkbox",
    "combobox",
    "link",
    "menuitem",
    "option",
    "radio",
    "switch",
    "tab",
    "textbox"
  ]);

  function isElementVisible(element) {
    if (!element || !element.isConnected) {
      return false;
    }

    const style = globalThis.getComputedStyle(element);
    if (!style || style.visibility === "hidden" || style.display === "none") {
      return false;
    }

    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function normalizeWhitespace(value) {
    return String(value ?? "").replace(/\s+/g, " ").trim();
  }

  function inferRole(element) {
    const explicitRole = normalizeWhitespace(element.getAttribute("role"));
    if (explicitRole) {
      return explicitRole.split(" ")[0];
    }

    const tagName = element.tagName.toLowerCase();
    if (tagName === "a" && element.hasAttribute("href")) {
      return "link";
    }
    if (tagName === "button") {
      return "button";
    }
    if (tagName === "input") {
      const type = (element.getAttribute("type") || "text").toLowerCase();
      if (type === "button" || type === "submit" || type === "reset") {
        return "button";
      }
      if (type === "checkbox") {
        return "checkbox";
      }
      if (type === "radio") {
        return "radio";
      }
      return "textbox";
    }
    if (tagName === "textarea") {
      return "textbox";
    }
    if (tagName === "select") {
      return "combobox";
    }
    if (tagName === "option") {
      return "option";
    }
    if (tagName === "img") {
      return "img";
    }
    if (tagName === "ul" || tagName === "ol") {
      return "list";
    }
    if (tagName === "li") {
      return "listitem";
    }
    if (tagName === "label") {
      return "label";
    }
    if (/^h[1-6]$/.test(tagName)) {
      return "heading";
    }
    if (tagName === "main") {
      return "main";
    }
    if (tagName === "nav") {
      return "navigation";
    }
    if (tagName === "section") {
      return "section";
    }
    if (tagName === "article") {
      return "article";
    }
    if (tagName === "form") {
      return "form";
    }
    if (tagName === "iframe") {
      return "iframe";
    }

    return "generic";
  }

  function labelTextFor(element) {
    if (!element.id) {
      return "";
    }
    const escapedId = globalThis.CSS && globalThis.CSS.escape ? globalThis.CSS.escape(element.id) : element.id;
    const labels = Array.from(rootDocument.querySelectorAll('label[for="' + escapedId + '"]'));
    return normalizeWhitespace(labels.map((label) => label.textContent || "").join(" "));
  }

  function accessibleName(element, role) {
    const ariaLabel = normalizeWhitespace(element.getAttribute("aria-label"));
    if (ariaLabel) {
      return ariaLabel;
    }

    const labelledBy = normalizeWhitespace(element.getAttribute("aria-labelledby"));
    if (labelledBy) {
      const ids = labelledBy.split(" ").map((value) => value.trim()).filter(Boolean);
      const text = ids
        .map((id) => rootDocument.getElementById(id))
        .filter(Boolean)
        .map((node) => node.textContent || "")
        .join(" ");
      const normalized = normalizeWhitespace(text);
      if (normalized) {
        return normalized;
      }
    }

    const tagName = element.tagName.toLowerCase();
    if (tagName === "img") {
      const alt = normalizeWhitespace(element.getAttribute("alt"));
      if (alt) {
        return alt;
      }
    }

    if (role === "textbox") {
      const label = labelTextFor(element);
      if (label) {
        return label;
      }
      const placeholder = normalizeWhitespace(element.getAttribute("placeholder"));
      if (placeholder) {
        return placeholder;
      }
      const value = normalizeWhitespace(element.value);
      if (value) {
        return value;
      }
    }

    if (tagName === "select") {
      const label = labelTextFor(element);
      if (label) {
        return label;
      }
      const selectedOption = element.options[element.selectedIndex];
      return normalizeWhitespace(selectedOption ? selectedOption.textContent : "");
    }

    if (tagName === "input") {
      const label = labelTextFor(element);
      if (label) {
        return label;
      }
      const inputValue = normalizeWhitespace(element.value);
      if (inputValue) {
        return inputValue;
      }
    }

    if (tagName === "iframe") {
      const title = normalizeWhitespace(element.getAttribute("title"));
      if (title) {
        return title;
      }
    }

    return normalizeWhitespace(element.textContent || "");
  }

  function shouldAssignRef(element, role) {
    if (mode !== "ai") {
      return false;
    }

    if (interactiveRoles.has(role)) {
      return true;
    }

    if (typeof element.onclick === "function") {
      return true;
    }

    const tabIndex = element.getAttribute("tabindex");
    return tabIndex !== null && Number(tabIndex) >= 0;
  }

  function shouldIncludeElement(element, role, name) {
    if (!isElementVisible(element)) {
      return false;
    }

    if (shouldAssignRef(element, role)) {
      return true;
    }

    if (role !== "generic" && role !== "section" && role !== "article") {
      return true;
    }

    return Boolean(name);
  }

  function createRef(element) {
    const ref = "r" + globalState.nextRefId++;
    const nodeToken = "n" + globalState.nextNodeId++;
    globalState.elements.set(nodeToken, element);
    globalState.refs.set(ref, nodeToken);
    return { ref, nodeToken };
  }

  function formatBox(element) {
    if (!includeBoxes) {
      return "";
    }

    const rect = element.getBoundingClientRect();
    return " [box=" + [rect.x, rect.y, rect.width, rect.height].map((value) => Math.round(value * 100) / 100).join(",") + "]";
  }

  const lines = ["- document"];
  const refs = {};

  function addTextNode(node, depth) {
    const text = normalizeWhitespace(node.textContent || "");
    if (!text) {
      return;
    }

    lines.push("  ".repeat(depth) + '- text "' + text + '"');
  }

  function walk(node, depth, suppressDirectText) {
    if (!node) {
      return;
    }

    if (node.nodeType === Node.TEXT_NODE) {
      if (!suppressDirectText) {
        addTextNode(node, depth);
      }
      return;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      return;
    }

    const element = node;
    const role = inferRole(element);
    const name = accessibleName(element, role);
    const include = shouldIncludeElement(element, role, name);
    const nextDepth = include ? depth + 1 : depth;
    const suppressChildrenText =
      role === "button" || role === "link" || role === "textbox" || role === "heading" || role === "label";

    if (include) {
      let line = "  ".repeat(depth) + "- " + role;
      if (name) {
        line += ' "' + name + '"';
      }
      if (shouldAssignRef(element, role)) {
        const created = createRef(element);
        refs[created.ref] = created.nodeToken;
        line += " [ref=" + created.ref + "]";
      }
      line += formatBox(element);
      lines.push(line);
    }

    if (maxDepth !== undefined && depth >= maxDepth) {
      return;
    }

    if (role === "iframe" && mode === "ai") {
      try {
        const frameDocument = element.contentDocument;
        const frameBody = frameDocument && (frameDocument.body || frameDocument.documentElement);
        if (frameBody) {
          for (const child of Array.from(frameBody.childNodes)) {
            walk(child, nextDepth, false);
          }
          return;
        }
      } catch {}
    }

    for (const child of Array.from(element.childNodes)) {
      walk(child, nextDepth, suppressChildrenText);
    }

    if (element.shadowRoot) {
      for (const child of Array.from(element.shadowRoot.childNodes)) {
        walk(child, nextDepth, suppressChildrenText);
      }
    }
  }

  const root = rootDocument.body || rootDocument.documentElement;
  walk(root, 1, false);

  return {
    refs,
    text: lines.join("\n"),
    title: normalizeWhitespace(rootDocument.title || ""),
    url: String(globalThis.location?.href || "")
  };
}`;

export const ARIA_REF_SELECTOR_EVALUATE_SOURCE = String.raw`(payload) => {
  const ref = String(payload && payload.ref ? payload.ref : "");
  const state = globalThis.__roxyMcpState;
  if (!state || !state.refs || !state.elements) {
    return { ok: false, reason: "stale" };
  }

  const nodeToken = state.refs.get(ref);
  if (!nodeToken) {
    return { ok: false, reason: "stale" };
  }

  const element = state.elements.get(nodeToken);
  if (!element || !element.isConnected) {
    return { ok: false, reason: "stale" };
  }

  function cssEscape(value) {
    if (globalThis.CSS && typeof globalThis.CSS.escape === "function") {
      return globalThis.CSS.escape(value);
    }
    return String(value).replace(/[^a-zA-Z0-9_\u00A0-\uFFFF-]/g, "\\$&");
  }

  function stringLiteral(value) {
    return JSON.stringify(String(value));
  }

  function xpathLiteral(value) {
    const input = String(value);
    if (!input.includes('"')) {
      return '"' + input + '"';
    }
    if (!input.includes("'")) {
      return "'" + input + "'";
    }
    return "concat(" + input.split('"').map((part, index, items) => {
      const tokens = [];
      if (part) {
        tokens.push('"' + part + '"');
      }
      if (index < items.length - 1) {
        tokens.push("'\"'");
      }
      return tokens.join(", ");
    }).filter(Boolean).join(", ") + ")";
  }

  function nthOfType(element) {
    let index = 1;
    let sibling = element.previousElementSibling;
    while (sibling) {
      if (sibling.tagName === element.tagName) {
        index += 1;
      }
      sibling = sibling.previousElementSibling;
    }
    return index;
  }

  function isInShadowTree(node) {
    if (!node || typeof node.getRootNode !== "function") {
      return false;
    }
    const root = node.getRootNode();
    return Boolean(root && root.host);
  }

  function selectorWithinDocument(target) {
    if (!target || !target.ownerDocument || isInShadowTree(target)) {
      return null;
    }

    const document = target.ownerDocument;
    if (target.id) {
      const selector = "#" + cssEscape(target.id);
      if (document.querySelector(selector) === target) {
        return selector;
      }
    }

    const segments = [];
    let current = target;
    while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.documentElement) {
      if (current.id) {
        const selector = "#" + cssEscape(current.id);
        if (document.querySelector(selector) === current) {
          segments.unshift(selector);
          break;
        }
      }

      const tagName = current.tagName.toLowerCase();
      segments.unshift(tagName + ":nth-of-type(" + nthOfType(current) + ")");
      current = current.parentElement;
      if (current && isInShadowTree(current)) {
        return null;
      }
    }

    if (current === document.documentElement) {
      segments.unshift("html");
    }

    return segments.join(" > ");
  }

  function xpathWithinDocument(target) {
    if (!target || !target.ownerDocument || isInShadowTree(target)) {
      return null;
    }

    if (target.id) {
      return "//*[@id=" + xpathLiteral(target.id) + "]";
    }

    const segments = [];
    let current = target;
    while (current && current.nodeType === Node.ELEMENT_NODE) {
      const tagName = current.tagName.toLowerCase();
      let index = 1;
      let sibling = current.previousElementSibling;
      while (sibling) {
        if (sibling.tagName === current.tagName) {
          index += 1;
        }
        sibling = sibling.previousElementSibling;
      }

      segments.unshift(tagName + "[" + index + "]");
      current = current.parentElement;
      if (current && isInShadowTree(current)) {
        return null;
      }
    }

    return "/" + segments.join("/");
  }

  function framePathForDocument(document) {
    const path = [];
    let view = document.defaultView;
    while (view && view.frameElement) {
      const frameElement = view.frameElement;
      path.unshift({
        selector: selectorWithinDocument(frameElement),
        xpath: xpathWithinDocument(frameElement)
      });
      view = frameElement.ownerDocument.defaultView;
    }
    return path;
  }

  function buildQuerySelectorChain(framePath, selector) {
    if (!selector) {
      return null;
    }

    let expression = "document";
    for (const frame of framePath) {
      if (!frame.selector) {
        return null;
      }
      expression += ".querySelector(" + stringLiteral(frame.selector) + ")";
      expression += "?.contentDocument";
    }

    expression += ".querySelector(" + stringLiteral(selector) + ")";
    return expression;
  }

  const selector = selectorWithinDocument(element);
  const xpath = xpathWithinDocument(element);
  const framePath = framePathForDocument(element.ownerDocument);
  const querySelectorChain = buildQuerySelectorChain(framePath, selector);

  return {
    ok: true,
    ref,
    selector,
    xpath,
    querySelector: framePath.length === 0 && selector
      ? "document.querySelector(" + stringLiteral(selector) + ")"
      : null,
    querySelectorChain,
    framePath,
    inShadowTree: isInShadowTree(element)
  };
}`;

export const ACTION_POINT_EVALUATE_SOURCE = String.raw`(payload) => {
  const state = globalThis.__roxyMcpState;
  if (!state || !state.elements || !state.elements.has(payload.nodeToken)) {
    return { ok: false, reason: "stale" };
  }

  const element = state.elements.get(payload.nodeToken);
  if (!element || !element.isConnected) {
    return { ok: false, reason: "stale" };
  }

  element.scrollIntoView({ block: "center", inline: "center" });
  const rect = element.getBoundingClientRect();
  if (!rect || rect.width <= 0 || rect.height <= 0) {
    return { ok: false, reason: "hidden" };
  }

  return {
    ok: true,
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2
  };
}`;

export async function withOptionalTimeout<TResult>(
  action: Promise<TResult>,
  timeout: number | undefined,
  message: string
): Promise<TResult> {
  if (!timeout || timeout <= 0) {
    return action;
  }

  return new Promise<TResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new TimeoutError(message));
    }, timeout);

    void action.then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

export function normalizeAriaSnapshotOptions(
  options: AriaSnapshotOptions = {}
): AriaSnapshotOptions {
  return {
    ...(options.boxes !== undefined ? { boxes: options.boxes } : {}),
    ...(options.depth !== undefined ? { depth: options.depth } : {}),
    ...(options.mode !== undefined ? { mode: options.mode } : {}),
    ...(options.timeout !== undefined ? { timeout: options.timeout } : {})
  };
}
