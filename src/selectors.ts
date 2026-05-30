import type { LocatorSelector } from "./protocol/adapter.js";

export function parseSelectorChain(selector: string): LocatorSelector[] {
  const parts = selector
    .split(/\s*>>\s*/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (!parts.length) {
    throw new Error("Selector must not be empty.");
  }

  return parts.map(parseSelectorPart);
}

function parseSelectorPart(part: string): LocatorSelector {
  const engineMatch = /^([a-zA-Z0-9-]+)\s*=(.*)$/s.exec(part);
  if (engineMatch) {
    const engine = engineMatch[1]!;
    const body = engineMatch[2]!;
    switch (engine) {
      case "css":
        return {
          strategy: "css",
          value: body.trim()
        };
      case "text":
        return parseTextSelector(body);
      case "xpath":
        return {
          strategy: "xpath",
          value: body.trim()
        };
      case "id":
        return {
          strategy: "css",
          value: `[id=${quoteAttributeValue(body.trim())}]`
        };
      case "data-test":
      case "data-testid":
      case "data-test-id":
        return {
          strategy: "css",
          value: `[${engine}=${quoteAttributeValue(body.trim())}]`
        };
      default:
        return {
          strategy: "css",
          value: part
        };
    }
  }

  if (
    (part.startsWith('"') && part.endsWith('"')) ||
    (part.startsWith("'") && part.endsWith("'"))
  ) {
    return parseTextSelector(part);
  }

  return {
    strategy: "css",
    value: part
  };
}

function parseTextSelector(body: string): LocatorSelector {
  const trimmed = body.trim();
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

  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
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
      return escaped === "x" ? "" : escaped;
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
