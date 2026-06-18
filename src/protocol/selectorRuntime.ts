import type {
  LocatorPick,
  LocatorSelector,
  ProtocolElementHandleReference
} from "./adapter.js";

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
  values?: Array<{ value?: string; label?: string; index?: number }>;
  checked?: boolean;
  name?: string;
  force?: boolean;
  missingMessage?: string;
  position?: { x: number; y: number };
  timeoutMs?: number;
  waitForEnabled?: boolean;
  resetSelectionIfNotFocused?: boolean;
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

  const querySelectorAllPierce = (root: ParentNode | Element, selector: string): Element[] => {
    const matches: Element[] = [];
    const visitRoot = (currentRoot: ParentNode | Element): void => {
      for (const element of toElements(currentRoot.querySelectorAll(selector))) {
        pushUnique(matches, element);
      }
      if (isElementNode(currentRoot)) {
        const shadowRoot = (currentRoot as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
        if (shadowRoot) {
          visitRoot(shadowRoot);
        }
      }
      for (const element of toElements(currentRoot.querySelectorAll("*"))) {
        const shadowRoot = (element as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
        if (shadowRoot) {
          visitRoot(shadowRoot);
        }
      }
    };
    visitRoot(root);
    return matches;
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
    return selector.exact
      ? normalizedCandidate === normalizedPattern
      : normalizedCandidate.includes(normalizedPattern);
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
    const ariaLabel = element.getAttribute("aria-label");
    if (ariaLabel) return normalize(ariaLabel);

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
      const matches: Element[] = [];
      if (includeRoot && isElementNode(root) && root.matches(selector.value)) {
        matches.push(root);
      }
      for (const element of querySelectorAllPierce(root, selector.value)) {
        pushUnique(matches, element);
      }
      return matches;
    }

    if (selector.strategy === "xpath") {
      return xpathCandidates(root, selector.value, includeRoot);
    }

    const descendants = descendantsOf(root, includeRoot);

    if (selector.strategy === "text") {
      const matching = descendants.filter((element) =>
        matchesPattern(
          (element as HTMLElement).innerText || element.textContent || "",
          selector,
          "value"
        )
      );

      return matching.filter((element) => {
        const childElements = descendantsOf(element, false);
        return !childElements.some((child) =>
          matchesPattern(
            (child as HTMLElement).innerText || child.textContent || "",
            selector,
            "value"
          )
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
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return (
      style.visibility !== "hidden" &&
      style.display !== "none" &&
      Number.parseFloat(style.opacity || "1") !== 0 &&
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
      if (element === scope || scope.contains(element)) {
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
    const firstElement = nodeToActionElement(firstNode);
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
        const firstElement = resolveSingleElement();
        return firstElement ? checkedState(firstElement) : false;
      }
    case "checkedState":
      {
        const firstElement = resolveSingleElement();
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
        const firstElement = resolveSingleElement();
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
        const selectedValues: string[] = [];

        if (firstElement.multiple) {
          for (const option of options) {
            option.selected = false;
          }
        }

        for (const candidate of requested) {
          const match = options.find((option, index) => {
            if (candidate.index !== undefined) {
              return index === candidate.index;
            }
            if (candidate.value !== undefined) {
              return option.value === candidate.value;
            }
            if (candidate.label !== undefined) {
              return option.label === candidate.label;
            }
            return false;
          });

          if (!match) {
            continue;
          }

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
            firstElement.textContent = payload.value ?? "";
          } else {
            throw new Error("Element is not an <input>, <textarea> or [contenteditable] element");
          }

          firstElement.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
          firstElement.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        };
        const waitResult = waitForFillActionability(firstElement);
        return waitResult instanceof Promise ? waitResult.then(fillElement) : fillElement();
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
