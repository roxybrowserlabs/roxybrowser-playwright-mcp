import type {
  LocatorPick,
  LocatorSelector,
  ProtocolElementHandleReference
} from "./adapter.js";

export interface SelectorRuntimePayload {
  operation:
    | "actionPoint"
    | "count"
    | "evaluate"
    | "evaluateAll"
    | "fill"
    | "focus"
    | "isVisible"
    | "textContent";
  reference: ProtocolElementHandleReference;
  expression?: string;
  arg?: unknown;
  value?: string;
  force?: boolean;
  missingMessage?: string;
  position?: { x: number; y: number };
  timeoutMs?: number;
}

function selectorRuntimeOperation(payload: SelectorRuntimePayload) {
  const normalize = (value: string | null | undefined): string =>
    (value ?? "").replace(/\s+/g, " ").trim();

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

  const compilePattern = (selector: LocatorSelector, kind: "value" | "name") => {
    const value = kind === "value" ? selector.value : selector.name ?? "";
    const isRegex = kind === "value" ? selector.isRegex : selector.nameIsRegex;
    const flags = kind === "value" ? selector.regexFlags : selector.nameRegexFlags;
    if (isRegex) {
      return new RegExp(value, flags ?? "");
    }
    return value;
  };

  const matchesPattern = (
    candidate: string,
    selector: LocatorSelector,
    kind: "value" | "name"
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

  const descendantsOf = (root: ParentNode | Element, includeRoot: boolean): Element[] => {
    const descendants: Element[] = [];
    if (includeRoot && root instanceof Element) {
      descendants.push(root);
    }

    if (root instanceof Document) {
      if (includeRoot && root.documentElement) {
        pushUnique(descendants, root.documentElement);
      }
      for (const element of toElements(root.querySelectorAll("*"))) {
        pushUnique(descendants, element);
      }
      return descendants;
    }

    for (const element of toElements(root.querySelectorAll("*"))) {
      pushUnique(descendants, element);
    }
    return descendants;
  };

  const xpathCandidates = (
    root: ParentNode | Element,
    expression: string,
    includeRoot: boolean
  ): Element[] => {
    const ownerDocument = root instanceof Document ? root : root.ownerDocument ?? document;
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
        continue;
      }
      if (!includeRoot && root instanceof Element && node === root) {
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
    if (selector.strategy === "css") {
      const matches: Element[] = [];
      if (includeRoot && root instanceof Element && root.matches(selector.value)) {
        matches.push(root);
      }
      for (const element of toElements(root.querySelectorAll(selector.value))) {
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

  const resolveReference = (reference: ProtocolElementHandleReference): Element[] => {
    const roots: Array<ParentNode | Element> = reference.scope
      ? resolveReference(reference.scope)
      : [document];

    if (!reference.chain.length) {
      return applyPick(
        roots.filter((node): node is Element => node instanceof Element),
        reference.pick
      );
    }

    let current = roots;
    for (let index = 0; index < reference.chain.length; index += 1) {
      const selector = reference.chain[index]!;
      const includeRoot = reference.scope ? index > 0 : true;
      const next: Element[] = [];
      for (const root of current) {
        for (const candidate of candidatesFromRoot(root, selector, includeRoot)) {
          pushUnique(next, candidate);
        }
      }
      current = next;
    }

    return applyPick(
      current.filter((node): node is Element => node instanceof Element),
      reference.pick
    );
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
  const resolveSingleElement = (): Element | null => resolveSingleElementFrom(resolveReference(payload.reference));
  const callUserFunction = (subject: unknown) => {
    const callback = (0, eval)(`(${payload.expression ?? "() => undefined"})`);
    return callback(subject, reviveArgument(payload.arg));
  };
  const resolveActionPointOnce = () => {
    const firstElement = resolveSingleElement();
    if (!firstElement) {
      throw new Error(payload.missingMessage ?? "No element found.");
    }

    firstElement.scrollIntoView({
      block: "center",
      inline: "center",
      behavior: "instant"
    });

    if (!payload.force && !isVisible(firstElement)) {
      throw new Error("Element is not visible.");
    }

    const rect = firstElement.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      throw new Error("Element does not have an actionable bounding box.");
    }

    const offsetX = payload.position ? payload.position.x : rect.width / 2;
    const offsetY = payload.position ? payload.position.y : rect.height / 2;

    return {
      x: rect.left + offsetX,
      y: rect.top + offsetY
    };
  };
  const shouldRetryActionPointError = (error: unknown): boolean => {
    if (!(error instanceof Error)) {
      return false;
    }

    return (
      error.message === "No element found." ||
      error.message === "Element is not visible." ||
      error.message === "Element does not have an actionable bounding box."
    );
  };
  const resolvedElements = resolveReference(payload.reference);

  switch (payload.operation) {
    case "count":
      return resolvedElements.length;
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
    case "textContent":
      {
        const firstElement = resolveSingleElement();
        return firstElement ? firstElement.textContent : null;
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
        if ("focus" in firstElement && typeof firstElement.focus === "function") {
          firstElement.focus();
        }
        return true;
      }
    case "fill":
      {
        const firstElement = resolveSingleElement();
        if (!firstElement) {
          throw new Error(payload.missingMessage ?? "No element found.");
        }
        if ("focus" in firstElement && typeof firstElement.focus === "function") {
          firstElement.focus();
        }

        if (firstElement instanceof HTMLInputElement || firstElement instanceof HTMLTextAreaElement) {
          firstElement.value = payload.value ?? "";
        } else if (firstElement instanceof HTMLElement && firstElement.isContentEditable) {
          firstElement.textContent = payload.value ?? "";
        } else {
          throw new Error("Element does not support fill().");
        }

        firstElement.dispatchEvent(new Event("input", { bubbles: true }));
        firstElement.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
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
