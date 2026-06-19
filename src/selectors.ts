import type { LocatorSelector } from "./protocol/adapter.js";

export function parseSelectorChain(selector: string): LocatorSelector[] {
  if (typeof selector !== "string") {
    throw new Error(`selector: expected string, got ${typeof selector}`);
  }

  const parts = splitSelectorChain(selector);

  if (!parts.length) {
    throw new Error("Selector must not be empty.");
  }

  let captured = false;
  return parts.map((part) => {
    const parsed = parseSelectorPart(part, selector);
    if (parsed.capture) {
      if (captured) {
        throw new Error("Only one of the selectors can capture using * modifier");
      }
      captured = true;
    }
    return parsed;
  });
}

function splitSelectorChain(selector: string): string[] {
  const parts: string[] = [];
  let quote: string | undefined;
  let escapeNext = false;
  let bracketDepth = 0;
  let parenDepth = 0;
  let braceDepth = 0;
  let start = 0;

  const shouldIgnoreTextSelectorQuote = (index: number): boolean => {
    const prefix = selector.substring(start, index);
    const match = prefix.match(/^\s*text\s*=(.*)$/s);
    return !!match && !!match[1];
  };

  const isInsideUnpairedTextSelectorQuoteLike = (index: number): boolean => {
    const prefix = selector.substring(start, index);
    const match = prefix.match(/^\s*text\s*=(.*)$/s);
    if (!match || !match[1]) {
      return false;
    }
    const body = match[1];
    const trimmedBody = body.trim();
    if (!trimmedBody || !/^[`'"]$/.test(trimmedBody)) {
      return false;
    }
    return true;
  };

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

    if ((char === '"' || char === "'") && !shouldIgnoreTextSelectorQuote(index)) {
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
    if (char === "{") {
      braceDepth += 1;
      continue;
    }
    if (char === "}") {
      braceDepth = Math.max(0, braceDepth - 1);
      continue;
    }

    if (
      char === ">" &&
      selector[index + 1] === ">" &&
      bracketDepth === 0 &&
      parenDepth === 0 &&
      braceDepth === 0 &&
      !isInsideUnpairedTextSelectorQuoteLike(index)
    ) {
      const part = selector.slice(start, index).trim();
      if (part) {
        parts.push(part);
      }
      index += 1;
      start = index + 1;
    }
  }

  const finalPart = selector.slice(start).trim();
  if (finalPart) {
    parts.push(finalPart);
  }
  return parts;
}

function parseSelectorPart(part: string, selectorText: string): LocatorSelector {
  let capture = false;
  let bodyPart = part;
  if (bodyPart === "*" && selectorText.trim() !== "*") {
    capture = true;
    bodyPart = "css=*";
  } else if (/^\*[a-zA-Z0-9-]*\s*=/.test(bodyPart)) {
    capture = true;
    bodyPart = bodyPart.slice(1);
  }

  const withCapture = (selector: LocatorSelector): LocatorSelector => ({
    ...selector,
    ...(capture ? { capture: true } : {})
  });

  const malformedCaptureMatch = /^([^=]*)=(.*)$/s.exec(bodyPart);
  if (capture && malformedCaptureMatch && !malformedCaptureMatch[1]!.trim()) {
    throw new Error(`Unknown engine "" while parsing selector ${selectorText}`);
  }

  const engineMatch = /^([a-zA-Z0-9-]+)\s*=(.*)$/s.exec(bodyPart);
  if (engineMatch) {
    const engine = engineMatch[1]!;
    const body = engineMatch[2]!;
    switch (engine) {
      case "internal:control":
        return withCapture({
          strategy: "control",
          value: body.trim()
        });
      case "css":
        return withCapture({
          strategy: "css",
          value: body.trim()
        });
      case "text":
        return withCapture(parseTextSelector(body));
      case "xpath":
        return withCapture({
          strategy: "xpath",
          value: body.trim()
        });
      case "id":
        return withCapture({
          strategy: "css",
          value: `[id=${quoteAttributeValue(body.trim())}]`
        });
      case "data-test":
      case "data-testid":
      case "data-test-id":
        return withCapture({
          strategy: "css",
          value: `[${engine}=${quoteAttributeValue(body.trim())}]`
        });
      default:
        throw new Error(`Unknown engine "${engine}" while parsing selector ${selectorText}`);
    }
  }

  if (
    (bodyPart.startsWith('"') && bodyPart.endsWith('"')) ||
    (bodyPart.startsWith("'") && bodyPart.endsWith("'"))
  ) {
    if (bodyPart.length === 1) {
      throw new Error(`Invalid selector ${selectorText}`);
    }
    return withCapture(parseTextSelector(bodyPart));
  }

  if (
    bodyPart.length > 1 &&
    (bodyPart.startsWith('"') || bodyPart.startsWith("'"))
  ) {
    throw new Error(`Invalid selector ${selectorText}`);
  }

  if (bodyPart.startsWith("//") || bodyPart.startsWith("(") || bodyPart.startsWith("..")) {
    return withCapture({
      strategy: "xpath",
      value: bodyPart
    });
  }

  return withCapture({
    strategy: "css",
    value: bodyPart
  });
}

function parseTextSelector(body: string): LocatorSelector {
  const trimmed = body.trim();
  const hasLeadingWhitespace = /^\s/.test(body);
  if (!trimmed) {
    return {
      strategy: "text",
      value: ""
    };
  }

  if (trimmed.startsWith("/") && trimmed.lastIndexOf("/") > 0) {
    const lastSlash = trimmed.lastIndexOf("/");
    const pattern = trimmed.slice(1, lastSlash);
    const flags = trimmed.slice(lastSlash + 1);
    return {
      strategy: "text",
      value: pattern,
      isRegex: true,
      regexFlags: flags
    };
  }

  if (trimmed === `"` || trimmed === `'`) {
    return {
      strategy: "text",
      value: trimmed
    };
  }

  const isQuoted =
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"));
  if (!hasLeadingWhitespace && isQuoted) {
    const quote = trimmed[0]!;
    return {
      strategy: "text",
      value: unescapeQuotedText(trimmed.slice(1, -1), quote),
      exact: true
    };
  }

  return {
    strategy: "text",
    value: trimmed
  };
}

function unescapeQuotedText(text: string, quote: string): string {
  return text.replace(/\\(.)/g, (_match, escaped) => {
    if (escaped === quote || escaped === "\\" || escaped === "x") {
      return escaped;
    }
    if (escaped === "n") {
      return "\n";
    }
    if (escaped === "t") {
      return "\t";
    }
    return escaped;
  });
}

function quoteAttributeValue(value: string): string {
  return JSON.stringify(unescapeQuotedText(value, '"'));
}
