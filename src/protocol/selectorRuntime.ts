import type {
  LocatorPick,
  LocatorSelector,
  ProtocolElementHandleReference
} from "./adapter.js";
import type { NormalizedSelectOption } from "../selectOptionValues.js";

export const SCROLL_INTO_VIEW_IF_NEEDED_SOURCE = `(element) => {
  const hasLayoutBox = (node) => {
    const rects = node.getClientRects();
    return rects.length > 0 && Array.from(rects).some((rect) => rect.width > 0 || rect.height > 0);
  };
  const findScrollableTarget = (node) => {
    if (hasLayoutBox(node))
      return node;
    const walker = node.ownerDocument.createTreeWalker(node, NodeFilter.SHOW_ELEMENT);
    let descendant = walker.nextNode();
    while (descendant) {
      if (hasLayoutBox(descendant))
        return descendant;
      descendant = walker.nextNode();
    }
    let ancestor = node.parentElement;
    while (ancestor) {
      if (hasLayoutBox(ancestor))
        return ancestor;
      ancestor = ancestor.parentElement;
    }
    return node;
  };
  findScrollableTarget(element).scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
}`;

export interface SelectOptionRetryResult {
  __needsRetry: true;
  reason: string;
}

export interface SelectorRuntimePayload {
  operation:
    | "actionPoint"
    | "boundingBox"
    | "check"
    | "checkedState"
    | "count"
    | "createHandle"
    | "dispatchEvent"
    | "evaluate"
    | "evaluateAll"
    | "fill"
    | "focus"
    | "getAttribute"
    | "innerHTML"
    | "innerText"
    | "inputValue"
    | "isChecked"
    | "isDisabled"
    | "isEditable"
    | "isEnabled"
    | "isVisible"
    | "selectOption"
    | "textContent";
  reference: ProtocolElementHandleReference;
  expression?: string;
  isFunction?: boolean;
  arg?: unknown;
  value?: string;
  values?: NormalizedSelectOption[];
  checked?: boolean;
  name?: string;
  force?: boolean;
  missingMessage?: string;
  position?: { x: number; y: number };
  timeoutMs?: number;
  waitForEnabled?: boolean;
  resetSelectionIfNotFocused?: boolean;
  retargetForAction?: "follow-label";
}

function selectorRuntimeOperation(payload: SelectorRuntimePayload) {
  const resolveBridgeScope = (): (typeof globalThis & Record<string, unknown>) => {
    const candidates: Array<typeof globalThis & Record<string, unknown>> = [
      globalThis as typeof globalThis & Record<string, unknown>
    ];
    try {
      if (globalThis.top) {
        candidates.unshift(globalThis.top as unknown as typeof globalThis & Record<string, unknown>);
      }
    } catch {}
    for (const candidate of candidates) {
      try {
        if (candidate.__roxyHandleStore) {
          return candidate;
        }
      } catch {}
    }
    return globalThis as typeof globalThis & Record<string, unknown>;
  };
  const globalState = resolveBridgeScope() as typeof globalThis & {
    __roxyHandleStore?: Record<string, Node | undefined>;
    __roxyNextHandleId?: number;
  };
  globalState.__roxyHandleStore ??= {};
  globalState.__roxyNextHandleId ??= 0;

  const normalize = (value: string | null | undefined): string =>
    (value ?? "").replace(/\s+/g, " ").trim();

  const textForSelector = (element: Element): string => {
    if (
      element instanceof HTMLInputElement &&
      ["button", "submit", "reset"].includes(element.type)
    ) {
      return element.value;
    }
    return element.textContent ?? "";
  };

  const immediateTextNodesForSelector = (element: Element): string[] =>
    Array.from(element.childNodes)
      .filter((node): node is Text => isTextNode(node))
      .map((node) => node.nodeValue ?? "");

  const matchesTextSelector = (element: Element, selector: LocatorSelector): boolean => {
    if (selector.exact && !selector.isRegex) {
      const immediateTextNodes = immediateTextNodesForSelector(element);
      if (!normalize(selector.value) && !immediateTextNodes.length) {
        return true;
      }
      return immediateTextNodes.some((text) =>
        matchesPattern(text, selector, "value")
      );
    }
    return matchesPattern(textForSelector(element), selector, "value");
  };

  type CssTextPseudoName = "text" | "text-is" | "text-matches" | "has-text";
  type CssTextPseudo = {
    name: CssTextPseudoName;
    args: string[];
    start: number;
    end: number;
  };

  const elementFullTextForSelector = (element: Element): string =>
    textForSelector(element);

  const elementImmediateTextForSelector = (element: Element): string[] =>
    immediateTextNodesForSelector(element);

  const elementMatchesCssTextPseudoSelf = (element: Element, pseudo: CssTextPseudo): boolean => {
    if (shouldSkipTextSelectorElement(element)) {
      return false;
    }

    if (pseudo.name === "text") {
      if (pseudo.args.length !== 1) {
        throw new Error(`"text" engine expects a single string`);
      }
      return normalize(elementFullTextForSelector(element))
        .toLowerCase()
        .includes(normalize(pseudo.args[0]).toLowerCase());
    }

    if (pseudo.name === "has-text") {
      if (pseudo.args.length !== 1) {
        throw new Error(`"has-text" engine expects a single string`);
      }
      return normalize(elementFullTextForSelector(element))
        .toLowerCase()
        .includes(normalize(pseudo.args[0]).toLowerCase());
    }

    if (pseudo.name === "text-is") {
      if (pseudo.args.length !== 1) {
        throw new Error(`"text-is" engine expects a single string`);
      }
      const text = normalize(pseudo.args[0]);
      const immediate = elementImmediateTextForSelector(element);
      if (!text && !immediate.length) {
        return true;
      }
      return immediate.some((candidate) => normalize(candidate) === text);
    }

    if (
      pseudo.args.length === 0 ||
      pseudo.args[0] === undefined ||
      pseudo.args.length > 2 ||
      (pseudo.args.length === 2 && typeof pseudo.args[1] !== "string")
    ) {
      throw new Error(`"text-matches" engine expects a regexp body and optional regexp flags`);
    }
    const regexp = new RegExp(pseudo.args[0], pseudo.args[1]);
    return regexp.test(elementFullTextForSelector(element));
  };

  const isDocumentNode = (node: unknown): node is Document =>
    !!node && typeof node === "object" && "nodeType" in node && (node as Node).nodeType === 9;

  const isElementNode = (node: unknown): node is Element =>
    !!node && typeof node === "object" && "nodeType" in node && (node as Node).nodeType === 1;

  const isNode = (node: unknown): node is Node =>
    !!node && typeof node === "object" && "nodeType" in node;

  const isTextNode = (node: unknown): node is Text =>
    isNode(node) && node.nodeType === 3;

  const tagNameOf = (node: unknown): string =>
    isElementNode(node) ? node.tagName.toLowerCase() : "";
  const activelyFocused = (node: Node): boolean => {
    const root = node.getRootNode();
    const activeElement = root instanceof Document || root instanceof ShadowRoot ? root.activeElement : null;
    return activeElement === node && !!node.ownerDocument && node.ownerDocument.hasFocus();
  };
  const focusElement = (element: Element): void => {
    const wasFocused = activelyFocused(element);
    if ("focus" in element && typeof element.focus === "function") {
      element.focus();
      element.focus();
    }
    if (payload.resetSelectionIfNotFocused && !wasFocused && element instanceof HTMLInputElement) {
      try {
        element.setSelectionRange(0, 0);
      } catch {}
    }
  };

  const isFrameElement = (node: unknown): node is HTMLIFrameElement | HTMLFrameElement => {
    const tagName = tagNameOf(node);
    return tagName === "iframe" || tagName === "frame";
  };

  const pushUnique = <T>(items: T[], candidate: T): void => {
    if (!items.includes(candidate)) {
      items.push(candidate);
    }
  };

  const toElements = (list: NodeListOf<Element> | HTMLCollectionOf<Element>): Element[] => {
    const elements: Element[] = [];
    for (let index = 0; index < list.length; index += 1) {
      const item = list[index];
      if (item) {
        elements.push(item);
      }
    }
    return elements;
  };

  const isInternalOverlayElement = (element: Element): boolean => {
    const tagName = element.tagName.toLowerCase();
    return (
      element.id === "__roxy_screencast_actions_style__" ||
      element.id === "__roxy_screencast_overlay_style__" ||
      tagName === "x-pw-action-overlays" ||
      tagName === "x-pw-user-overlays" ||
      element.closest("x-pw-action-overlays,x-pw-user-overlays,[data-roxy-highlight-overlay]") !== null
    );
  };

  const shouldSkipTextSelectorElement = (element: Element): boolean => {
    const tagName = element.tagName.toLowerCase();
    return (
      tagName === "head" ||
      tagName === "script" ||
      tagName === "style" ||
      isInternalOverlayElement(element)
    );
  };

  const querySelectorAllPierce = (
    root: ParentNode | Element,
    selector: string,
    shadowSelector = selector
  ): Element[] => {
    const matches: Element[] = [];
    const visitRoot = (currentRoot: ParentNode | Element, isInitialRoot: boolean): void => {
      const currentSelector = isInitialRoot ? selector : shadowSelector;
      for (const element of toElements(currentRoot.querySelectorAll(currentSelector))) {
        if (!isInternalOverlayElement(element)) {
          pushUnique(matches, element);
        }
      }
      if (isElementNode(currentRoot)) {
        const shadowRoot = (currentRoot as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
        if (shadowRoot) {
          visitRoot(shadowRoot, false);
        }
      }
      for (const element of toElements(currentRoot.querySelectorAll("*"))) {
        const shadowRoot = (element as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
        if (shadowRoot) {
          visitRoot(shadowRoot, false);
        }
      }
    };
    visitRoot(root, true);
    return matches;
  };

  const relativeCssSelector = (selector: string): string =>
    /^[>+~]/.test(selector.trim()) ? `:scope ${selector}` : selector;

  const scopeCssSelectorList = (selector: string): string =>
    splitCssSelectorList(selector)
      .map((part) => `:scope ${part}`)
      .join(", ");

  const splitCssSelectorList = (selector: string): string[] => {
    const parts: string[] = [];
    let quote: string | undefined;
    let escapeNext = false;
    let bracketDepth = 0;
    let parenDepth = 0;
    let start = 0;

    for (let index = 0; index < selector.length; index += 1) {
      const char = selector[index]!;
      if (escapeNext) {
        escapeNext = false;
        continue;
      }
      if (quote) {
        if (char === "\\") {
          escapeNext = true;
        } else if (char === quote) {
          quote = undefined;
        }
        continue;
      }
      if (char === '"' || char === "'") {
        quote = char;
        continue;
      }
      if (char === "[") {
        bracketDepth += 1;
        continue;
      }
      if (char === "]") {
        bracketDepth = Math.max(0, bracketDepth - 1);
        continue;
      }
      if (char === "(") {
        parenDepth += 1;
        continue;
      }
      if (char === ")") {
        parenDepth = Math.max(0, parenDepth - 1);
        continue;
      }
      if (char === "," && bracketDepth === 0 && parenDepth === 0) {
        const part = selector.slice(start, index).trim();
        if (part) {
          parts.push(part);
        }
        start = index + 1;
      }
    }

    const finalPart = selector.slice(start).trim();
    if (finalPart) {
      parts.push(finalPart);
    }
    return parts.length ? parts : [selector];
  };

  const queryCss = (root: ParentNode | Element, selector: string, includeRoot: boolean): Element[] => {
    const normalizedSelector = normalizeHasScopeSelector(relativeCssSelector(selector));
    const cssTextPseudoSelector = parseCssTextPseudoSelector(normalizedSelector);
    if (cssTextPseudoSelector) {
      return queryCssTextPseudo(root, cssTextPseudoSelector, includeRoot);
    }
    const matches: Element[] = [];

    if (includeRoot && isElementNode(root) && root.matches(normalizedSelector)) {
      matches.push(root);
    }

    if (!isElementNode(root)) {
      for (const element of querySelectorAllPierce(root, normalizedSelector)) {
        pushUnique(matches, element);
      }
      return matches;
    }

    if (!/^[>+~]/.test(selector.trim()) && !selector.includes(":scope")) {
      const querySelector = isElementNode(root) && root.tagName.toLowerCase() !== "html"
        ? scopeCssSelectorList(normalizedSelector)
        : normalizedSelector;
      for (const element of querySelectorAllPierce(root, querySelector, normalizedSelector)) {
        pushUnique(matches, element);
      }
      return matches;
    }

    const scopeAttribute = `data-roxy-scope-${Date.now().toString(36)}-${Math.floor(Math.random() * 1_000_000).toString(36)}`;
    const hadScopeAttribute = root.hasAttribute(scopeAttribute);
    const previousScopeAttribute = root.getAttribute(scopeAttribute);
    root.setAttribute(scopeAttribute, "");
    try {
      const scopedSelector = normalizedSelector.replace(/:scope\b/g, `[${scopeAttribute}]`);
      const queryRoot = root.parentElement ?? root.getRootNode();
      const candidates = queryRoot instanceof Document || queryRoot instanceof ShadowRoot || isElementNode(queryRoot)
        ? querySelectorAllPierce(queryRoot, scopedSelector)
        : [];
      for (const element of candidates) {
        pushUnique(matches, element);
      }
      return matches;
    } finally {
      if (hadScopeAttribute && previousScopeAttribute !== null) {
        root.setAttribute(scopeAttribute, previousScopeAttribute);
      } else {
        root.removeAttribute(scopeAttribute);
      }
    }
  };

  const normalizeHasScopeSelector = (selector: string): string =>
    selector.replace(/:has\(\s*:scope\s*([>+~])/g, ":has($1");

  const parseCssTextPseudoSelector = (selector: string): {
    baseSelector: string;
    descendantSelector?: string;
    pseudos: CssTextPseudo[];
  } | null => {
    const head = splitCssTextPseudoHead(selector);
    if (!head) {
      return null;
    }

    const pseudos: CssTextPseudo[] = [];
    let quote: string | undefined;
    let escapeNext = false;
    let bracketDepth = 0;
    let replacement = "";
    let cursor = 0;

    for (let index = 0; index < head.selector.length; index += 1) {
      const char = head.selector[index]!;
      if (escapeNext) {
        escapeNext = false;
        continue;
      }
      if (quote) {
        if (char === "\\") {
          escapeNext = true;
        } else if (char === quote) {
          quote = undefined;
        }
        continue;
      }
      if (char === '"' || char === "'") {
        quote = char;
        continue;
      }
      if (char === "[") {
        bracketDepth += 1;
        continue;
      }
      if (char === "]") {
        bracketDepth = Math.max(0, bracketDepth - 1);
        continue;
      }
      if (bracketDepth !== 0 || char !== ":") {
        continue;
      }

      const nameMatch = /^:(text-is|text-matches|has-text|text)\s*\(/.exec(head.selector.slice(index));
      if (!nameMatch) {
        continue;
      }

      const name = nameMatch[1] as CssTextPseudoName;
      const argsStart = index + nameMatch[0].length;
      const argsEnd = findCssFunctionEnd(head.selector, argsStart);
      if (argsEnd === -1) {
        continue;
      }

      const argsSource = head.selector.slice(argsStart, argsEnd);
      const args = parseCssTextPseudoArgs(name, argsSource);
      pseudos.push({
        name,
        args,
        start: index,
        end: argsEnd + 1
      });
      replacement += head.selector.slice(cursor, index);
      cursor = argsEnd + 1;
      index = argsEnd;
    }

    replacement += head.selector.slice(cursor);
    const trimmedReplacement = replacement.trim();
    const baseSelector = trimmedReplacement || "*";
    return {
      baseSelector,
      ...(head.descendantSelector ? { descendantSelector: head.descendantSelector } : {}),
      pseudos
    };
  };

  const splitCssTextPseudoHead = (selector: string): {
    selector: string;
    descendantSelector?: string;
  } | null => {
    let quote: string | undefined;
    let escapeNext = false;
    let bracketDepth = 0;
    let parenDepth = 0;
    let firstPseudoEnd = -1;

    for (let index = 0; index < selector.length; index += 1) {
      const char = selector[index]!;
      if (escapeNext) {
        escapeNext = false;
        continue;
      }
      if (quote) {
        if (char === "\\") {
          escapeNext = true;
        } else if (char === quote) {
          quote = undefined;
        }
        continue;
      }
      if (char === '"' || char === "'") {
        quote = char;
        continue;
      }
      if (char === "[") {
        bracketDepth += 1;
        continue;
      }
      if (char === "]") {
        bracketDepth = Math.max(0, bracketDepth - 1);
        continue;
      }
      if (char === "(") {
        parenDepth += 1;
        continue;
      }
      if (char === ")") {
        parenDepth = Math.max(0, parenDepth - 1);
        continue;
      }
      if (bracketDepth === 0 && parenDepth === 0 && char === ":") {
        const nameMatch = /^:(text-is|text-matches|has-text|text)\s*\(/.exec(selector.slice(index));
        if (nameMatch) {
          const argsStart = index + nameMatch[0].length;
          const argsEnd = findCssFunctionEnd(selector, argsStart);
          if (argsEnd !== -1) {
            firstPseudoEnd = argsEnd + 1;
            index = argsEnd;
            continue;
          }
        }
      }
      if (firstPseudoEnd !== -1 && bracketDepth === 0 && parenDepth === 0 && /\s/.test(char)) {
        const headSelector = selector.slice(0, index).trim();
        const descendantSelector = selector.slice(index).trim();
        if (headSelector && descendantSelector) {
          return { selector: headSelector, descendantSelector };
        }
      }
    }
    return firstPseudoEnd === -1 ? null : { selector };
  };

  const findCssFunctionEnd = (selector: string, argsStart: number): number => {
    let quote: string | undefined;
    let escapeNext = false;
    let depth = 1;
    for (let index = argsStart; index < selector.length; index += 1) {
      const char = selector[index]!;
      if (escapeNext) {
        escapeNext = false;
        continue;
      }
      if (quote) {
        if (char === "\\") {
          escapeNext = true;
        } else if (char === quote) {
          quote = undefined;
        }
        continue;
      }
      if (char === '"' || char === "'") {
        quote = char;
        continue;
      }
      if (char === "(") {
        depth += 1;
        continue;
      }
      if (char === ")") {
        depth -= 1;
        if (depth === 0) {
          return index;
        }
      }
    }
    return -1;
  };

  const parseCssTextPseudoArgs = (name: CssTextPseudoName, argsSource: string): string[] => {
    const args: string[] = [];
    let quote: string | undefined;
    let escapeNext = false;
    let current = "";
    let hasNonWhitespaceOutsideString = false;

    for (let index = 0; index < argsSource.length; index += 1) {
      const char = argsSource[index]!;
      if (escapeNext) {
        current += cssUnescapeCharacter(char);
        escapeNext = false;
        continue;
      }
      if (quote) {
        if (char === "\\") {
          escapeNext = true;
        } else if (char === quote) {
          quote = undefined;
        } else {
          current += char;
        }
        continue;
      }
      if (char === '"' || char === "'") {
        quote = char;
        continue;
      }
      if (char === ",") {
        args.push(current);
        current = "";
        hasNonWhitespaceOutsideString = false;
        continue;
      }
      if (!/\s/.test(char)) {
        hasNonWhitespaceOutsideString = true;
      }
      current += char;
    }

    if (quote || hasNonWhitespaceOutsideString) {
      throwCssTextPseudoArgumentError(name);
    }

    args.push(current);
    return args.map((arg) => arg.trim());
  };

  const cssUnescapeCharacter = (char: string): string => {
    if (char.toLowerCase() === "a") {
      return "\n";
    }
    if (char === "n") {
      return "\n";
    }
    if (char === "t") {
      return "\t";
    }
    return char;
  };

  const throwCssTextPseudoArgumentError = (name: CssTextPseudoName): never => {
    if (name === "text") {
      throw new Error(`"text" engine expects a single string`);
    }
    if (name === "text-is") {
      throw new Error(`"text-is" engine expects a single string`);
    }
    if (name === "has-text") {
      throw new Error(`"has-text" engine expects a single string`);
    }
    throw new Error(`"text-matches" engine expects a regexp body and optional regexp flags`);
  };

  const elementMatchesCssTextPseudos = (element: Element, pseudos: CssTextPseudo[]): boolean => {
    for (const pseudo of pseudos) {
      if (!elementMatchesCssTextPseudoSelf(element, pseudo)) {
        return false;
      }
      if (pseudo.name === "text" || pseudo.name === "text-matches") {
        const childElements = descendantsOf(element, false);
        if (childElements.some((child) => elementMatchesCssTextPseudoSelf(child, pseudo))) {
          return false;
        }
      }
    }
    return true;
  };

  const queryCssTextPseudo = (
    root: ParentNode | Element,
    parsed: { baseSelector: string; descendantSelector?: string; pseudos: CssTextPseudo[] },
    includeRoot: boolean
  ): Element[] => {
    const candidates = parsed.baseSelector === "*"
      ? descendantsOf(root, includeRoot)
      : queryCss(root, parsed.baseSelector, includeRoot);
    const matching = candidates.filter((element) => elementMatchesCssTextPseudos(element, parsed.pseudos));
    if (!parsed.descendantSelector) {
      return matching;
    }

    const descendants: Element[] = [];
    for (const element of matching) {
      for (const descendant of queryCss(element, parsed.descendantSelector, false)) {
        pushUnique(descendants, descendant);
      }
    }
    return descendants;
  };

  const compilePattern = (selector: LocatorSelector, kind: "value" | "name" | "label") => {
    const value =
      kind === "value" ? selector.value : kind === "name" ? selector.name ?? "" : selector.label ?? "";
    const isRegex =
      kind === "value" ? selector.isRegex : kind === "name" ? selector.nameIsRegex : selector.labelIsRegex;
    const flags =
      kind === "value" ? selector.regexFlags : kind === "name" ? selector.nameRegexFlags : selector.labelRegexFlags;
    if (isRegex) {
      return new RegExp(value, flags ?? "");
    }
    return value;
  };

  const matchesPattern = (
    candidate: string,
    selector: LocatorSelector,
    kind: "value" | "name" | "label"
  ): boolean => {
    const pattern = compilePattern(selector, kind);
    const normalizedCandidate = normalize(candidate);

    if (pattern instanceof RegExp) {
      return pattern.test(normalizedCandidate);
    }

    const normalizedPattern = normalize(pattern);
    if (selector.exact) {
      return normalizedCandidate === normalizedPattern;
    }

    return normalizedCandidate.toLowerCase().includes(normalizedPattern.toLowerCase());
  };

  const implicitRole = (element: Element): string | null => {
    const tagName = element.tagName.toLowerCase();
    if (tagName === "button") return "button";
    if (tagName === "a" && element.hasAttribute("href")) return "link";
    if (tagName === "textarea") return "textbox";
    if (tagName === "select") {
      return element.hasAttribute("multiple") ? "listbox" : "combobox";
    }
    if (tagName === "img") return "img";
    if (tagName !== "input") return null;

    const type = (element.getAttribute("type") ?? "text").toLowerCase();
    switch (type) {
      case "button":
      case "submit":
      case "reset":
        return "button";
      case "checkbox":
        return "checkbox";
      case "radio":
        return "radio";
      case "range":
        return "slider";
      case "email":
      case "password":
      case "search":
      case "tel":
      case "text":
      case "url":
        return "textbox";
      default:
        return null;
    }
  };

  const roleOf = (element: Element): string | null =>
    normalize(element.getAttribute("role")) || implicitRole(element);

  const accessibleName = (element: Element): string => {
    const labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy) {
      const ids = labelledBy.split(/\s+/);
      const parts: string[] = [];
      for (const id of ids) {
        const node = document.getElementById(id);
        if (node) {
          parts.push(normalize(node.innerText || node.textContent));
        }
      }
      const text = parts.join(" ");
      if (text) return normalize(text);
    }

    const ariaLabel = element.getAttribute("aria-label");
    if (ariaLabel) return normalize(ariaLabel);

    const labels =
      "labels" in element
        ? Array.from(
            ((element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLButtonElement)
              .labels ?? []) as Iterable<HTMLLabelElement>
          )
        : [];
    if (labels.length) {
      const labelText = labels
        .map((label) => normalize((label as HTMLElement).innerText || label.textContent))
        .filter(Boolean)
        .join(" ");
      if (labelText) return normalize(labelText);
    }

    if (
      element instanceof HTMLInputElement &&
      ["button", "submit", "reset"].includes(element.type)
    ) {
      return normalize(element.value);
    }

    return normalize((element as HTMLElement).innerText || element.textContent);
  };

  const labelTextForControl = (element: Element): string => {
    const ariaLabelledBy = element.getAttribute("aria-labelledby");
    if (ariaLabelledBy) {
      const text = ariaLabelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id))
        .filter((node): node is HTMLElement => Boolean(node))
        .map((node) => normalize(node.innerText || node.textContent))
        .join(" ");
      if (text) {
        return normalize(text);
      }
    }

    const ariaLabel = element.getAttribute("aria-label");
    if (ariaLabel) {
      return normalize(ariaLabel);
    }

    const labels =
      "labels" in element
        ? Array.from(
            ((element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLButtonElement)
              .labels ?? []) as Iterable<HTMLLabelElement>
          )
        : [];
    if (labels.length) {
      return normalize(
        labels
          .map((label) => normalize((label as HTMLElement).innerText || label.textContent))
          .filter(Boolean)
          .join(" ")
      );
    }

    return "";
  };

  const attributeValueForSelector = (element: Element, selector: LocatorSelector): string | null => {
    switch (selector.label) {
      case "alt":
        return element.getAttribute("alt");
      case "label":
        return labelTextForControl(element);
      case "placeholder":
        return element.getAttribute("placeholder");
      case "testId":
        return (
          element.getAttribute("data-testid") ??
          element.getAttribute("data-test-id") ??
          element.getAttribute("data-test")
        );
      case "title":
        return element.getAttribute("title");
      default:
        return null;
    }
  };

  const descendantsOf = (root: ParentNode | Element, includeRoot: boolean): Element[] => {
    const descendants: Element[] = [];
    if (includeRoot && isElementNode(root)) {
      descendants.push(root);
    }

    if (isDocumentNode(root)) {
      if (includeRoot && root.documentElement) {
        pushUnique(descendants, root.documentElement);
      }
      for (const element of querySelectorAllPierce(root, "*")) {
        pushUnique(descendants, element);
      }
      return descendants;
    }

    for (const element of querySelectorAllPierce(root, "*")) {
      pushUnique(descendants, element);
    }
    return descendants;
  };

  const xpathCandidates = (
    root: ParentNode | Element,
    expression: string,
    includeRoot: boolean
  ): Element[] => {
    const ownerDocument = isDocumentNode(root) ? root : root.ownerDocument ?? document;
    const result = ownerDocument.evaluate(
      expression,
      root,
      null,
      XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
      null
    );
    const elements: Element[] = [];
    for (let index = 0; index < result.snapshotLength; index += 1) {
      const node = result.snapshotItem(index);
      if (!(node instanceof Element)) {
        if (!isElementNode(node)) {
          continue;
        }
      }
      if (!includeRoot && isElementNode(root) && node === root) {
        continue;
      }
      pushUnique(elements, node);
    }
    return elements;
  };

  const candidatesFromRoot = (
    root: ParentNode | Element,
    selector: LocatorSelector,
    includeRoot: boolean
  ): Element[] => {
    if (selector.strategy === "control") {
      return [];
    }

    if (selector.strategy === "css") {
      if (selector.label) {
        return descendantsOf(root, includeRoot).filter((element) => {
          const value = attributeValueForSelector(element, selector);
          return value !== null && matchesPattern(value, selector, "value");
        });
      }
      return queryCss(root, selector.value, includeRoot);
    }

    if (selector.strategy === "xpath") {
      return xpathCandidates(root, selector.value, includeRoot);
    }

    const descendants = descendantsOf(root, includeRoot);

    if (selector.strategy === "text") {
      const matching = descendants.filter((element) => {
        if (shouldSkipTextSelectorElement(element)) {
          return false;
        }
        return matchesTextSelector(element, selector);
      });

      return matching.filter((element) => {
        const childElements = descendantsOf(element, false);
        return !childElements.some((child) =>
          !shouldSkipTextSelectorElement(child) &&
          matchesTextSelector(child, selector)
        );
      });
    }

    return descendants.filter((element) => {
      if (roleOf(element) !== selector.value) {
        return false;
      }

      if (selector.name === undefined && !selector.nameIsRegex) {
        return true;
      }

      return matchesPattern(accessibleName(element), selector, "name");
    });
  };

  const applyPick = <TElement extends Element>(elements: TElement[], pick?: LocatorPick): TElement[] => {
    if (!pick) {
      return elements;
    }
    if (pick.kind === "first") {
      return elements.slice(0, 1);
    }
    if (pick.kind === "last") {
      return elements.slice(-1);
    }
    const pickedElement = elements[pick.index];
    return pickedElement ? [pickedElement] : [];
  };

  type SelectorMatch = {
    node: ParentNode | Element;
    capture: Element | null;
  };

  const resolveReference = (reference: ProtocolElementHandleReference): Node[] => {
    if (reference.handleId) {
      const node = globalState.__roxyHandleStore?.[reference.handleId] ?? null;
      return node ? [node] : [];
    }

    const roots: Array<ParentNode | Element> = reference.scope
      ? resolveReference(reference.scope)
        .filter((node): node is ParentNode | Element => isElementNode(node) || isDocumentNode(node))
      : [document];

    if (!reference.chain.length) {
      return applyPick(
        roots.filter((node): node is Element => node instanceof Element),
        reference.pick
      );
    }

    let current: SelectorMatch[] = roots.map((root) => ({
      node: root,
      capture: null
    }));
    for (let index = 0; index < reference.chain.length; index += 1) {
      const selector = reference.chain[index]!;
      if (selector.strategy === "control" && selector.value === "enter-frame") {
        const next: SelectorMatch[] = [];
        for (const match of current) {
          if (!isFrameElement(match.node)) {
            continue;
          }
          const contentDocument = match.node.contentDocument;
          if (contentDocument) {
            next.push({
              node: contentDocument,
              capture: match.capture
            });
          }
        }
        current = next;
        continue;
      }

      const includeRoot = (!reference.scope && index === 0) || selector.strategy === "text";
      const next: SelectorMatch[] = [];
      for (const match of current) {
        for (const candidate of candidatesFromRoot(match.node, selector, includeRoot)) {
          const capture = selector.capture ? candidate : match.capture;
          if (!next.some((entry) => entry.node === candidate && entry.capture === capture)) {
            next.push({
              node: candidate,
              capture
            });
          }
        }
      }
      current = next;
    }

    const resolved: Element[] = [];
    for (const match of current) {
      const node = match.capture ?? match.node;
      if (isElementNode(node)) {
        pushUnique(resolved, node);
      }
    }
    return applyPick(resolved, reference.pick);
  };

  const reviveArgument = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map((entry) => reviveArgument(entry));
    }

    if (value && typeof value === "object") {
      if ("__roxyElementHandle" in value) {
        const reference = (value as { __roxyElementHandle: ProtocolElementHandleReference })
          .__roxyElementHandle;
        return resolveReference(reference)[0] ?? null;
      }
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [key, reviveArgument(entry)])
      );
    }

    return value;
  };

  const isVisible = (element: Element): boolean => {
    const rect = element.getBoundingClientRect();
    return (
      hasVisibleStyle(element) &&
      rect.width > 0 &&
      rect.height > 0
    );
  };
  const hasVisibleStyle = (element: Element): boolean => {
    let current: Element | null = element;
    while (current) {
      const style = window.getComputedStyle(current);
      if (
        style.visibility === "hidden" ||
        style.display === "none" ||
        Number.parseFloat(style.opacity || "1") === 0
      ) {
        return false;
      }
      current = current.parentElement;
    }
    return true;
  };
  const isDisabled = (element: Element): boolean => {
    if (element instanceof HTMLOptionElement && element.parentElement instanceof HTMLOptGroupElement && element.parentElement.disabled) {
      return true;
    }
    if (
      element instanceof HTMLButtonElement ||
      element instanceof HTMLInputElement ||
      element instanceof HTMLSelectElement ||
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLOptGroupElement ||
      element instanceof HTMLOptionElement ||
      element instanceof HTMLFieldSetElement
    ) {
      return element.disabled;
    }
    let current: Element | undefined = element;
    while (current) {
      const ariaDisabled = current.getAttribute("aria-disabled")?.toLowerCase();
      if (ariaDisabled === "true") {
        return true;
      }
      if (ariaDisabled === "false") {
        return false;
      }
      current = parentElementOrShadowHost(current);
    }
    return false;
  };
  const isEditable = (element: Element): boolean => {
    if (
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLSelectElement
    ) {
      return !element.hasAttribute("readonly") && !isDisabled(element);
    }
    if (element instanceof HTMLElement && element.isContentEditable) {
      return !isDisabled(element);
    }
    const ariaReadonlyRoles = new Set([
      "checkbox",
      "combobox",
      "grid",
      "gridcell",
      "listbox",
      "radiogroup",
      "slider",
      "spinbutton",
      "textbox",
      "columnheader",
      "rowheader",
      "searchbox",
      "switch",
      "treegrid"
    ]);
    if (ariaReadonlyRoles.has(element.getAttribute("role") ?? "")) {
      return !isDisabled(element) && element.getAttribute("aria-readonly") !== "true";
    }
    throw new Error("Element is not an <input>, <textarea>, <select> or [contenteditable] and does not have a role allowing [aria-readonly]");
  };
  const isEnabled = (element: Element): boolean => !isDisabled(element);
  const fillActionabilityError = (element: Element): string | null => {
    if (!payload.force && !isVisible(element)) {
      return "Element is not visible.";
    }
    if (!payload.force && !isEnabled(element)) {
      return "Element is not enabled.";
    }
    if (!payload.force && !isEditable(element)) {
      return "Element is not editable.";
    }
    return null;
  };
  const waitForFillActionability = (element: Element): void | Promise<void> => {
    const assertActionable = () => {
      const error = fillActionabilityError(element);
      if (error) {
        throw new Error(error);
      }
    };
    if (payload.force || !payload.timeoutMs || payload.timeoutMs <= 0) {
      assertActionable();
      return;
    }
    return new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + payload.timeoutMs!;
      const tick = () => {
        try {
          assertActionable();
          resolve();
        } catch (error) {
          if (Date.now() + 50 > deadline) {
            reject(error);
            return;
          }
          setTimeout(tick, 50);
        }
      };
      tick();
    });
  };
  const isChecked = (element: Element): boolean => {
    if (element instanceof HTMLInputElement) {
      return element.checked;
    }
    const ariaChecked = element.getAttribute("aria-checked");
    return ariaChecked === "true" || ariaChecked === "mixed";
  };
  const checkboxLikeRoles = new Set([
    "checkbox",
    "menuitemcheckbox",
    "menuitemradio",
    "option",
    "radio",
    "switch",
    "treeitem"
  ]);
  const checkedState = (element: Element): boolean => {
    if (element instanceof HTMLInputElement) {
      const type = element.type.toLowerCase();
      if (type !== "checkbox" && type !== "radio") {
        throw new Error("Not a checkbox or radio button");
      }
      return element.checked;
    }
    if (!checkboxLikeRoles.has(element.getAttribute("role") ?? "")) {
      throw new Error("Not a checkbox or radio button");
    }
    return isChecked(element);
  };
  const inputValue = (element: Element): string => {
    if (
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLSelectElement
    ) {
      return element.value;
    }
    throw new Error("Node is not an <input>, <textarea> or <select> element.");
  };
  const fillInputValue = (input: HTMLInputElement, value: string): string => {
    const type = input.type.toLowerCase();
    const inputTypesToSetValue = new Set(["color", "date", "time", "datetime-local", "month", "range", "week"]);
    const inputTypesToTypeInto = new Set(["", "email", "number", "password", "search", "tel", "text", "url"]);
    if (!inputTypesToTypeInto.has(type) && !inputTypesToSetValue.has(type)) {
      throw new Error(`Input of type "${type}" cannot be filled`);
    }
    if (type === "number") {
      value = value.trim();
      if (isNaN(Number(value))) {
        throw new Error("Cannot type text into input[type=number]");
      }
    }
    if (type === "color") {
      value = value.toLowerCase();
    }
    if (inputTypesToSetValue.has(type)) {
      value = value.trim();
      input.value = value;
      if (input.value !== value) {
        throw new Error("Malformed value");
      }
    }
    return value;
  };
  const innerTextValue = (element: Element): string => {
    if (element instanceof HTMLElement) {
      return element.innerText;
    }
    throw new Error("Node is not an HTMLElement.");
  };
  const innerHTMLValue = (element: Element): string => {
    if (element instanceof HTMLElement || element instanceof SVGElement) {
      return element.innerHTML;
    }
    throw new Error("Node does not expose innerHTML.");
  };
  const createDOMEvent = (type: string, eventInit: any): Event => {
    const baseInit = {
      bubbles: true,
      cancelable: true,
      composed: true,
      ...(eventInit && typeof eventInit === "object" ? eventInit : {})
    };
    if (type.startsWith("mouse") || type === "click" || type === "dblclick" || type === "contextmenu") {
      return new MouseEvent(type, baseInit);
    }
    if (type === "wheel") {
      return new WheelEvent(type, baseInit);
    }
    if (type.startsWith("drag") || type === "drop") {
      return new DragEvent(type, baseInit);
    }
    if (type.startsWith("key")) {
      return new KeyboardEvent(type, baseInit);
    }
    if (type === "input") {
      return new InputEvent(type, baseInit);
    }
    return new Event(type, baseInit);
  };

  const formatElementForStrictViolation = (element: Element): string => {
    const tag = element.tagName.toLowerCase();
    const id = "id" in element && typeof element.id === "string" && element.id ? `#${element.id}` : "";
    const className =
      "className" in element &&
      typeof element.className === "string" &&
      element.className.trim()
        ? `.${element.className.trim().replace(/\s+/g, ".")}`
        : "";
    const text = normalize(
      (element instanceof HTMLElement
        ? element.innerText || element.textContent || ""
        : element.textContent || "")
    );
    return `${tag}${id}${className}${text ? ` (${text})` : ""}`;
  };
  const nodeToActionElement = (node: Node): Element | null => {
    if (isElementNode(node)) {
      return node;
    }
    return isTextNode(node) && isElementNode(node.parentElement) ? node.parentElement : null;
  };
  const parentElementOrShadowHost = (element: Element): Element | undefined => {
    if (element.parentElement) {
      return element.parentElement;
    }
    if (!element.parentNode) {
      return undefined;
    }
    if (element.parentNode.nodeType === 11 && (element.parentNode as ShadowRoot).host) {
      return (element.parentNode as ShadowRoot).host;
    }
    return undefined;
  };
  const isInsideScope = (scope: Node, element: Element | null): boolean => {
    while (element) {
      if (element === scope) {
        return true;
      }
      element = parentElementOrShadowHost(element) ?? null;
    }
    return false;
  };

  const resolveSingleElementFrom = (elements: Element[]): Element | null => {
    if (!payload.reference.pick && elements.length > 1) {
      const preview = elements
        .slice(0, 3)
        .map((element) => formatElementForStrictViolation(element))
        .join(", ");
      throw new Error(
        `strict mode violation: locator resolved to ${elements.length} elements${
          preview ? `: ${preview}` : ""
        }`
      );
    }
    return elements[0] ?? null;
  };
  const resolveSingleElement = (): Element | null =>
    resolveSingleElementFrom(resolveReference(payload.reference).filter((node): node is Element => isElementNode(node)));
  const resolveSingleNode = (): Node | null => resolveReference(payload.reference)[0] ?? null;
  const retargetElement = (node: Node | null, behavior: "none" | "follow-label" | "no-follow-label" | "button-link"): Element | null => {
    let element = node ? nodeToActionElement(node) : null;
    if (!element) {
      return null;
    }
    if (behavior === "none") {
      return element;
    }
    if (!element.matches("input, textarea, select") && !(element instanceof HTMLElement && element.isContentEditable)) {
      if (behavior === "button-link") {
        element = element.closest("button, [role=button], a, [role=link]") ?? element;
      } else {
        element = element.closest("button, [role=button], [role=checkbox], [role=radio]") ?? element;
      }
    }
    if (behavior === "follow-label") {
      if (
        !element.matches("a, input, textarea, button, select, [role=link], [role=button], [role=checkbox], [role=radio]") &&
        !(element instanceof HTMLElement && element.isContentEditable)
      ) {
        const enclosingLabel = element.closest("label");
        if (enclosingLabel instanceof HTMLLabelElement && enclosingLabel.control) {
          element = enclosingLabel.control;
        }
      }
    }
    return element;
  };
  const resolveRetargetedElement = (behavior: "none" | "follow-label" | "no-follow-label" | "button-link"): Element | null =>
    retargetElement(resolveSingleNode(), behavior);
  const callUserFunction = (subject: unknown) => {
    const expression = payload.expression ?? "undefined";
    let result = payload.isFunction === true
      ? (0, eval)(`(${expression})`)
      : (0, eval)(expression);
    if (payload.isFunction === true) {
      result = result(subject, reviveArgument(payload.arg));
    } else if (payload.isFunction === undefined && typeof result === "function") {
      result = result(subject, reviveArgument(payload.arg));
    }
    return result;
  };
  const resolveActionPointOnce = () => {
    const firstNode = resolveSingleNode();
    if (!firstNode) {
      throw new Error(payload.missingMessage ?? "No element found.");
    }
    if (!firstNode.isConnected) {
      throw new Error("Element is not attached to the DOM");
    }
    const firstElement = payload.retargetForAction === "follow-label"
      ? retargetElement(firstNode, "follow-label")
      : nodeToActionElement(firstNode);
    if (!firstElement) {
      throw new Error("Element is not attached to the DOM");
    }

    firstElement.scrollIntoView({
      block: "center",
      inline: "center",
      behavior: "instant"
    });

    if (!hasVisibleStyle(firstElement)) {
      throw new Error("Element is not visible.");
    }
    if (payload.waitForEnabled && !isEnabled(firstElement)) {
      throw new Error("Element is not enabled.");
    }

    const viewportRect = {
      bottom: window.innerHeight,
      left: 0,
      right: window.innerWidth,
      top: 0
    };
    const intersectWithViewport = (rect: DOMRect): DOMRect | null => {
      const left = Math.max(rect.left, viewportRect.left);
      const right = Math.min(rect.right, viewportRect.right);
      const top = Math.max(rect.top, viewportRect.top);
      const bottom = Math.min(rect.bottom, viewportRect.bottom);
      if (right - left <= 0 || bottom - top <= 0) {
        return null;
      }
      return new DOMRect(left, top, right - left, bottom - top);
    };
    const chooseActionRect = (element: Element): DOMRect | null => {
      for (const candidate of Array.from(element.getClientRects())) {
        const visiblePart = intersectWithViewport(candidate);
        if (visiblePart && visiblePart.width * visiblePart.height > 0.99) {
          return visiblePart;
        }
      }
      const visibleBoundingBox = intersectWithViewport(element.getBoundingClientRect());
      if (visibleBoundingBox && visibleBoundingBox.width * visibleBoundingBox.height > 0.99) {
        return visibleBoundingBox;
      }
      return null;
    };

    const rect = isTextNode(firstNode)
      ? (() => {
          const range = document.createRange();
          range.selectNodeContents(firstNode);
          const rangeRect = (() => {
            for (const candidate of Array.from(range.getClientRects())) {
              const visiblePart = intersectWithViewport(candidate);
              if (visiblePart && visiblePart.width * visiblePart.height > 0.99) {
                return visiblePart;
              }
            }
            return intersectWithViewport(range.getBoundingClientRect());
          })();
          range.detach();
          return rangeRect;
        })()
      : chooseActionRect(firstElement);
    if (!rect || rect.width <= 0 || rect.height <= 0) {
      throw new Error("Element is outside of the viewport.");
    }

    const offsetX = payload.position ? payload.position.x : rect.width / 2;
    const offsetY = payload.position ? payload.position.y : rect.height / 2;

    let frameOffsetX = 0;
    let frameOffsetY = 0;
    let currentWindow: Window | null = firstElement.ownerDocument.defaultView;
    while (currentWindow && isElementNode(currentWindow.frameElement)) {
      const frameRect = currentWindow.frameElement.getBoundingClientRect();
      frameOffsetX += frameRect.left;
      frameOffsetY += frameRect.top;
      currentWindow = currentWindow.parent === currentWindow ? null : currentWindow.parent;
    }

    const x = frameOffsetX + rect.left + offsetX;
    const y = frameOffsetY + rect.top + offsetY;
    if (!payload.force) {
      const hitTarget = firstElement.ownerDocument.elementFromPoint(rect.left + offsetX, rect.top + offsetY);
      if (hitTarget && !isInsideScope(firstElement, hitTarget) && !isInsideScope(hitTarget, firstElement)) {
        throw new Error("Element intercepts pointer events.");
      }
    }

    return { x, y };
  };
  const frameOffsetForElement = (element: Element): { x: number; y: number } => {
    let x = 0;
    let y = 0;
    let currentWindow: Window | null = element.ownerDocument.defaultView;
    while (currentWindow && isElementNode(currentWindow.frameElement)) {
      const frameRect = currentWindow.frameElement.getBoundingClientRect();
      x += frameRect.left;
      y += frameRect.top;
      currentWindow = currentWindow.parent === currentWindow ? null : currentWindow.parent;
    }
    return { x, y };
  };
  const shouldRetryActionPointError = (error: unknown): boolean => {
    if (!(error instanceof Error)) {
      return false;
    }

    return (
      error.message === "No element found." ||
      error.message === "Element is not visible." ||
      error.message === "Element is not enabled." ||
      error.message === "Element does not have an actionable bounding box." ||
      error.message === "Element intercepts pointer events."
    );
  };
  const resolvedElements = resolveReference(payload.reference);
  const firstResolvedNode = (): Node | null => resolveReference(payload.reference)[0] ?? null;

  switch (payload.operation) {
    case "count":
      return resolvedElements.length;
    case "boundingBox":
      {
        const firstElement = resolveSingleElement();
        if (!firstElement || !firstElement.isConnected) {
          return null;
        }
        const rect = firstElement.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {
          return null;
        }
        const offset = frameOffsetForElement(firstElement);
        return {
          x: rect.x + offset.x,
          y: rect.y + offset.y,
          width: rect.width,
          height: rect.height
        };
      }
    case "createHandle":
      {
        resolveSingleElement();
        const firstNode = resolveReference(payload.reference)[0] ?? null;
        if (!firstNode) {
          throw new Error(payload.missingMessage ?? "No element found.");
        }
        const handleId = `handle:${++globalState.__roxyNextHandleId!}`;
        globalState.__roxyHandleStore![handleId] = firstNode;
        return {
          handleId
        };
      }
    case "evaluate":
      {
        const firstElement = resolveSingleElement();
        if (!firstElement) {
          throw new Error(payload.missingMessage ?? "No element found.");
        }
        return callUserFunction(firstElement);
      }
    case "evaluateAll":
      return callUserFunction(resolvedElements);
    case "dispatchEvent":
      {
        const firstElement = resolveSingleElement();
        if (!firstElement) {
          throw new Error(payload.missingMessage ?? "No element found.");
        }
        const eventInit = reviveArgument(payload.arg);
        const event = createDOMEvent(String(payload.name ?? "event"), eventInit);
        firstElement.dispatchEvent(event);
        return undefined;
      }
    case "textContent":
      {
        const firstNode = firstResolvedNode();
        return firstNode ? firstNode.textContent : null;
      }
    case "innerText":
      {
        const firstElement = resolveSingleElement();
        if (!firstElement) {
          throw new Error(payload.missingMessage ?? "No element found.");
        }
        return innerTextValue(firstElement);
      }
    case "innerHTML":
      {
        const firstElement = resolveSingleElement();
        if (!firstElement) {
          throw new Error(payload.missingMessage ?? "No element found.");
        }
        return innerHTMLValue(firstElement);
      }
    case "getAttribute":
      {
        const firstElement = resolveSingleElement();
        return firstElement ? firstElement.getAttribute(payload.name ?? "") : null;
      }
    case "inputValue":
      {
        const firstElement = resolveSingleElement();
        if (!firstElement) {
          throw new Error(payload.missingMessage ?? "No element found.");
        }
        return inputValue(firstElement);
      }
    case "isChecked":
      {
        const firstElement = resolveRetargetedElement("follow-label");
        return firstElement ? checkedState(firstElement) : false;
      }
    case "checkedState":
      {
        const firstElement = resolveRetargetedElement("follow-label");
        if (!firstElement) {
          throw new Error(payload.missingMessage ?? "No element found.");
        }
        return checkedState(firstElement);
      }
    case "isDisabled":
      {
        const firstElement = resolveSingleElement();
        return firstElement ? isDisabled(firstElement) : false;
      }
    case "isEditable":
      {
        const firstElement = resolveSingleElement();
        return firstElement ? isEditable(firstElement) : false;
      }
    case "isEnabled":
      {
        const firstElement = resolveSingleElement();
        return firstElement ? isEnabled(firstElement) : false;
      }
    case "isVisible":
      {
        const firstElement = resolveSingleElement();
        return firstElement ? isVisible(firstElement) : false;
      }
    case "focus":
      {
        const firstElement = resolveSingleElement();
        if (!firstElement) {
          throw new Error(payload.missingMessage ?? "No element found.");
        }
        focusElement(firstElement);
        return true;
      }
    case "check":
      {
        const firstElement = resolveRetargetedElement("follow-label");
        if (!firstElement) {
          throw new Error(payload.missingMessage ?? "No element found.");
        }
        const desired = payload.checked ?? true;
        if (firstElement instanceof HTMLInputElement && firstElement.type.toLowerCase() === "radio" && !desired) {
          throw new Error("Cannot uncheck radio button");
        }
        checkedState(firstElement);
        return true;
      }
    case "selectOption":
      {
        const firstElement = resolveSingleElement();
        if (!(firstElement instanceof HTMLSelectElement)) {
          throw new Error("Element is not a <select> element.");
        }
        const requested = payload.values ?? [];
        const options = Array.from(firstElement.options);
        const findMatch = (candidate: { value?: string; label?: string; index?: number }) => {
          return options.find((option, index) => {
            if (candidate.index !== undefined && index !== candidate.index) {
              return false;
            }
            if (candidate.value !== undefined && option.value !== candidate.value) {
              return false;
            }
            if (candidate.label !== undefined && option.label !== candidate.label) {
              return false;
            }
            if (candidate.index === undefined && candidate.value === undefined && candidate.label === undefined) {
              return false;
            }
            return true;
          }) ?? (
            candidate.index === undefined && candidate.label === undefined && candidate.value !== undefined
              ? options.find((option) => option.label === candidate.value)
              : undefined
          );
        };
        const isOptionEnabled = (option: HTMLOptionElement): boolean => {
          let parent = option.parentElement;
          while (parent) {
            if (parent instanceof HTMLOptGroupElement && parent.disabled) {
              return false;
            }
            parent = parent.parentElement;
          }
          return !option.disabled;
        };
        const matchedOptions: HTMLOptionElement[] = [];
        for (const candidate of requested) {
          const match = findMatch(candidate);
          if (!match) {
            return {
              __needsRetry: true,
              reason: "No matching option"
            };
          }
          if (isDisabled(firstElement) || !isOptionEnabled(match)) {
            throw new Error("option being selected is not enabled");
          }
          matchedOptions.push(match);
          if (!firstElement.multiple) {
            break;
          }
        }
        const selectedValues: string[] = [];

        if (firstElement.multiple || requested.length === 0) {
          for (const option of options) {
            option.selected = false;
          }
        }

        for (const match of matchedOptions) {
          match.selected = true;
          selectedValues.push(match.value);
          if (!firstElement.multiple) {
            break;
          }
        }

        firstElement.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
        firstElement.dispatchEvent(new Event("change", { bubbles: true }));
        return selectedValues;
      }
    case "fill":
      {
        const firstElement = resolveSingleElement();
        if (!firstElement) {
          throw new Error(payload.missingMessage ?? "No element found.");
        }
        const fillElement = () => {
          if ("focus" in firstElement && typeof firstElement.focus === "function") {
            firstElement.focus();
          }

          if (firstElement instanceof HTMLInputElement) {
            firstElement.value = fillInputValue(firstElement, payload.value ?? "");
          } else if (firstElement instanceof HTMLTextAreaElement) {
            firstElement.value = payload.value ?? "";
          } else if (firstElement instanceof HTMLElement && firstElement.isContentEditable) {
            const selection = window.getSelection();
            const range = document.createRange();
            range.selectNodeContents(firstElement);
            selection?.removeAllRanges();
            selection?.addRange(range);
            const value = payload.value ?? "";
            const edited = value
              ? document.execCommand("insertText", false, value)
              : document.execCommand("delete");
            if (!edited) {
              firstElement.textContent = value;
            }
            return true;
          } else {
            throw new Error("Element is not an <input>, <textarea> or [contenteditable] element");
          }

          firstElement.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
          firstElement.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        };
        if (payload.timeoutMs !== undefined) {
          const waitResult = waitForFillActionability(firstElement);
          return waitResult instanceof Promise ? waitResult.then(fillElement) : fillElement();
        }
        const error = fillActionabilityError(firstElement);
        if (error) {
          throw new Error(error);
        }
        return fillElement();
      }
    case "actionPoint":
      {
        if (payload.force || !payload.timeoutMs || payload.timeoutMs <= 0) {
          return resolveActionPointOnce();
        }

        return new Promise<{ x: number; y: number }>((resolve, reject) => {
          const deadline = Date.now() + payload.timeoutMs!;

          const tick = () => {
            try {
              resolve(resolveActionPointOnce());
            } catch (error) {
              if (!shouldRetryActionPointError(error) || Date.now() + 50 > deadline) {
                reject(error);
                return;
              }
              setTimeout(tick, 50);
            }
          };

          tick();
        });
      }
    default:
      throw new Error(`Unsupported selector runtime operation: ${payload.operation as string}`);
  }
}

export const SELECTOR_RUNTIME_SOURCE = selectorRuntimeOperation.toString();
