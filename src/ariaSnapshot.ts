import { TimeoutError } from "./errors.js";
import type { AriaSnapshotOptions } from "./types/options.js";

export interface AriaSnapshotResult {
  refs: Record<string, string>;
  text: string;
  title: string;
  url: string;
  error?: {
    code: "stale" | "not_found" | "invalid_selector" | "strict";
    message?: string;
  };
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
  const target = payload && payload.target ? payload.target : undefined;
  const maxDepth = typeof options.depth === "number" ? options.depth : undefined;
  const includeBoxes = Boolean(options.boxes);
  const mode = options.mode === "ai" ? "ai" : "default";
  const rootDocument = document;
  const previousState = globalThis.__roxyMcpState ?? {
    elements: new Map(),
    refs: new Map(),
    nextRefId: 1,
    nextNodeId: 1
  };
  const previousElements = previousState.elements instanceof Map ? previousState.elements : new Map();
  const globalState = {
    elements: new Map(),
    refs: new Map(),
    nextRefId: typeof previousState.nextRefId === "number" ? previousState.nextRefId : 1,
    nextNodeId: typeof previousState.nextNodeId === "number" ? previousState.nextNodeId : 1
  };
  globalState.elements = new Map();
  globalState.refs = new Map();
  globalThis.__roxyMcpState = globalState;

  const structuralRolesWithoutImplicitName = new Set([
    "article",
    "form",
    "generic",
    "list",
    "listitem",
    "main",
    "navigation",
    "section"
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

  function formatInlineText(value) {
    const text = normalizeWhitespace(value);
    if (!text) {
      return "";
    }
    return /^[\w\s.,!?:;<>/=+-]+$/.test(text) ? text : JSON.stringify(text);
  }

  function receivesPointerEvents(element) {
    const style = globalThis.getComputedStyle(element);
    return !style || style.pointerEvents !== "none";
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
    const ownerDocument = element.ownerDocument || rootDocument;
    const escapedId = globalThis.CSS && globalThis.CSS.escape ? globalThis.CSS.escape(element.id) : element.id;
    const labels = Array.from(ownerDocument.querySelectorAll('label[for="' + escapedId + '"]'));
    return normalizeWhitespace(labels.map((label) => label.textContent || "").join(" "));
  }

  function accessibleName(element, role) {
    const ownerDocument = element.ownerDocument || rootDocument;
    const ariaLabel = normalizeWhitespace(element.getAttribute("aria-label"));
    if (ariaLabel) {
      return ariaLabel;
    }

    const labelledBy = normalizeWhitespace(element.getAttribute("aria-labelledby"));
    if (labelledBy) {
      const ids = labelledBy.split(" ").map((value) => value.trim()).filter(Boolean);
      const text = ids
        .map((id) => ownerDocument.getElementById(id))
        .filter(Boolean)
        .map((node) => node.textContent || "")
        .join(" ");
      const normalized = normalizeWhitespace(text);
      if (normalized) {
        return normalized;
      }
    }

    const tagName = element.tagName.toLowerCase();
    if (structuralRolesWithoutImplicitName.has(role)) {
      return "";
    }

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
      return "";
    }

    if (tagName === "select") {
      const label = labelTextFor(element);
      if (label) {
        return label;
      }
      return "";
    }

    if (tagName === "input") {
      const label = labelTextFor(element);
      if (label) {
        return label;
      }
      return "";
    }

    if (tagName === "iframe") {
      const title = normalizeWhitespace(element.getAttribute("title"));
      if (title) {
        return title;
      }
    }

    return normalizeWhitespace(element.textContent || "");
  }

  function createRef(element) {
    const existingRef = element.__roxyAriaRef;
    const ref = typeof existingRef === "string" ? existingRef : "e" + globalState.nextRefId++;
    element.__roxyAriaRef = ref;
    const nodeToken = "n" + globalState.nextNodeId++;
    globalState.elements.set(nodeToken, element);
    globalState.refs.set(ref, nodeToken);
    return { ref, nodeToken };
  }

  function createAriaNode(element) {
    const role = inferRole(element);
    const name = accessibleName(element, role);
    const rect = element.getBoundingClientRect();
    const node = {
      role,
      name,
      children: [],
      ref: undefined,
      active: element.ownerDocument.activeElement === element,
      level: /^h[1-6]$/.test(element.tagName.toLowerCase()) ? Number(element.tagName[1]) : undefined,
      checked: undefined,
      selected: undefined,
      box: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      }
    };

    if (
      mode === "ai" &&
      isElementVisible(element) &&
      receivesPointerEvents(element)
    ) {
      node.ref = createRef(element).ref;
    }

    if (role === "checkbox" || role === "radio") {
      node.checked = Boolean(element.checked);
    }
    if (role === "option") {
      node.selected = Boolean(element.selected);
    }
    if (role === "textbox" && typeof element.value === "string" && element.type !== "checkbox" && element.type !== "radio") {
      node.children.push(element.value);
    }

    return node;
  }

  function resolveRootNode() {
    if (!target) {
      return {
        ok: true,
        node: rootDocument.body || rootDocument.documentElement
      };
    }

    if (target.nodeToken) {
      const element = previousElements.get(String(target.nodeToken));
      if (!element || !element.isConnected) {
        return {
          ok: false,
          error: {
            code: "stale"
          }
        };
      }
      return {
        ok: true,
        node: element
      };
    }

    if (target.selector) {
      try {
        const elements = Array.from(rootDocument.querySelectorAll(String(target.selector)));
        if (elements.length === 0) {
          return {
            ok: false,
            error: {
              code: "not_found",
              message: '"' + String(target.selector) + '" does not match any element.'
            }
          };
        }
        if (elements.length > 1) {
          return {
            ok: false,
            error: {
              code: "strict",
              message: 'strict mode violation: "' + String(target.selector) + '" matches multiple elements.'
            }
          };
        }
        return {
          ok: true,
          node: elements[0]
        };
      } catch (error) {
        return {
          ok: false,
          error: {
            code: "invalid_selector",
            message: String(error && error.message ? error.message : error)
          }
        };
      }
    }

    return {
      ok: false,
      error: {
        code: "not_found"
      }
    };
  }

  function visitDom(parentAriaNode, node, forceInclude) {
    if (!node) {
      return;
    }

    if (node.nodeType === Node.TEXT_NODE) {
      const text = normalizeWhitespace(node.nodeValue || "");
      if (text && parentAriaNode.role !== "textbox") {
        parentAriaNode.children.push(text);
      }
      return;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      return;
    }

    const element = node;
    const visible = isElementVisible(element);
    const role = inferRole(element);
    const include = forceInclude || visible || role === "iframe";
    const ariaNode = include ? createAriaNode(element) : parentAriaNode;

    if (include) {
      parentAriaNode.children.push(ariaNode);
    }

    if (ariaNode.role === "iframe" && mode === "ai") {
      try {
        const frameDocument = element.contentDocument;
        const frameBody = frameDocument && (frameDocument.body || frameDocument.documentElement);
        if (frameBody) {
          for (const child of Array.from(frameBody.childNodes)) {
            visitDom(ariaNode, child, false);
          }
          return;
        }
      } catch {}
    }

    const assignedNodes = element.tagName === "SLOT" && typeof element.assignedNodes === "function"
      ? element.assignedNodes()
      : [];
    if (assignedNodes.length) {
      for (const child of Array.from(assignedNodes)) {
        visitDom(ariaNode, child, false);
      }
    } else {
      for (const child of Array.from(element.childNodes)) {
        if (!child.assignedSlot) {
          visitDom(ariaNode, child, false);
        }
      }
      if (element.shadowRoot) {
        for (const child of Array.from(element.shadowRoot.childNodes)) {
          visitDom(ariaNode, child, false);
        }
      }
    }
  }

  function normalizeChildren(node) {
    const normalizedChildren = [];
    const textBuffer = [];

    const flushText = () => {
      if (!textBuffer.length) {
        return;
      }
      const text = normalizeWhitespace(textBuffer.join(" "));
      if (text) {
        normalizedChildren.push(text);
      }
      textBuffer.length = 0;
    };

    for (const child of node.children) {
      if (typeof child === "string") {
        textBuffer.push(child);
        continue;
      }
      flushText();
      normalizeChildren(child);
      normalizedChildren.push(child);
    }
    flushText();
    node.children = normalizedChildren;
    if (node.children.length === 1 && node.children[0] === node.name) {
      node.children = [];
    }
  }

  function flattenGenericNodes(node) {
    const flattenedChildren = [];
    for (const child of node.children) {
      if (typeof child === "string") {
        flattenedChildren.push(child);
        continue;
      }
      const flattened = flattenGenericNodes(child);
      for (const nested of flattened) {
        flattenedChildren.push(nested);
      }
    }
    node.children = flattenedChildren;
    const removeSelf =
      node.role === "generic" &&
      !node.name &&
      flattenedChildren.length <= 1 &&
      flattenedChildren.every((child) => typeof child !== "string" && child.ref);
    return removeSelf ? flattenedChildren : [node];
  }

  function renderNode(node, depth, lines) {
    if (maxDepth !== undefined && depth > maxDepth) {
      return;
    }

    let line = "  ".repeat(depth) + "- " + node.role;
    if (node.name) {
      line += " " + JSON.stringify(node.name);
    }
    if (node.checked) {
      line += " [checked]";
    }
    if (node.selected) {
      line += " [selected]";
    }
    if (node.active) {
      line += " [active]";
    }
    if (node.level) {
      line += " [level=" + node.level + "]";
    }
    if (node.ref) {
      line += " [ref=" + node.ref + "]";
    }
    if (includeBoxes) {
      line += " [box=" + [node.box.x, node.box.y, node.box.width, node.box.height].join(",") + "]";
    }

    const singleInlineText =
      node.children.length === 1 && typeof node.children[0] === "string"
        ? formatInlineText(node.children[0])
        : "";
    const depthLimited = maxDepth !== undefined && depth === maxDepth;

    if (singleInlineText) {
      lines.push(line + ": " + singleInlineText);
      return;
    }

    if (!node.children.length || depthLimited) {
      lines.push(line);
      return;
    }

    lines.push(line + ":");
    for (const child of node.children) {
      if (typeof child === "string") {
        const text = formatInlineText(child);
        if (text) {
          lines.push("  ".repeat(depth + 1) + "- text: " + text);
        }
        continue;
      }
      renderNode(child, depth + 1, lines);
    }
  }

  const resolvedRoot = resolveRootNode();
  if (!resolvedRoot.ok) {
    return {
      refs: {},
      text: "",
      title: normalizeWhitespace(rootDocument.title || ""),
      url: String(globalThis.location?.href || ""),
      error: resolvedRoot.error
    };
  }

  const root = {
    role: "fragment",
    children: []
  };
  visitDom(root, resolvedRoot.node, Boolean(target));
  for (const child of root.children) {
    if (typeof child !== "string") {
      normalizeChildren(child);
    }
  }

  const renderedRoots = [];
  for (const child of root.children) {
    if (typeof child === "string") {
      const text = formatInlineText(child);
      if (text) {
        renderedRoots.push(text);
      }
      continue;
    }
    for (const flattened of flattenGenericNodes(child)) {
      renderedRoots.push(flattened);
    }
  }

  const lines = [];
  for (const child of renderedRoots) {
    if (typeof child === "string") {
      lines.push("- text: " + child);
      continue;
    }
    renderNode(child, 0, lines);
  }

  return {
    refs: Object.fromEntries(globalState.refs.entries()),
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
    const input = String(value);
    if (globalThis.CSS && typeof globalThis.CSS.escape === "function") {
      return globalThis.CSS.escape(input);
    }

    let output = "";
    for (let index = 0; index < input.length; index += 1) {
      const character = input.charCodeAt(index);
      const symbol = input.charAt(index);

      if (character === 0x0000) {
        output += "\uFFFD";
        continue;
      }

      const isControlCharacter =
        (character >= 0x0001 && character <= 0x001f) || character === 0x007f;
      const isLeadingDigit = index === 0 && character >= 0x0030 && character <= 0x0039;
      const isSecondDigitAfterLeadingHyphen =
        index === 1 &&
        character >= 0x0030 &&
        character <= 0x0039 &&
        input.charCodeAt(0) === 0x002d;
      if (isControlCharacter || isLeadingDigit || isSecondDigitAfterLeadingHyphen) {
        output += "\\" + character.toString(16) + " ";
        continue;
      }

      if (index === 0 && input.length === 1 && symbol === "-") {
        output += "\\-";
        continue;
      }

      const isIdentifierCharacter =
        character >= 0x0080 ||
        character === 0x002d ||
        character === 0x005f ||
        (character >= 0x0030 && character <= 0x0039) ||
        (character >= 0x0041 && character <= 0x005a) ||
        (character >= 0x0061 && character <= 0x007a);

      output += isIdentifierCharacter ? symbol : "\\" + symbol;
    }

    return output;
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

  function hasUniqueIdInDocument(target) {
    if (!target || !target.ownerDocument || !target.id || isInShadowTree(target)) {
      return false;
    }

    const selector = "#" + cssEscape(target.id);
    const matches = target.ownerDocument.querySelectorAll(selector);
    return matches.length === 1 && matches[0] === target;
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
    if (hasUniqueIdInDocument(target)) {
      const selector = "#" + cssEscape(target.id);
      return selector;
    }

    const segments = [];
    let current = target;
    while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.documentElement) {
      if (hasUniqueIdInDocument(current)) {
        const selector = "#" + cssEscape(current.id);
        segments.unshift(selector);
        break;
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

    if (hasUniqueIdInDocument(target)) {
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

export const ACTION_POINT_BY_SELECTOR_SOURCE = String.raw`(payload) => {
  const element = document.querySelector(payload.selector);
  if (!element || !element.isConnected) {
    return { ok: false, reason: "not_found" };
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
