import { escapeWithQuotes } from "./utils.js";

type ParsedLocatorOrSelector = {
  selector: string;
  resolved?: string | undefined;
};

function cssString(value: string): string {
  return JSON.stringify(value);
}

function cssAttributeName(value: string): string {
  if (/^-?[_a-zA-Z]+[_a-zA-Z0-9-]*$/.test(value)) {
    return value;
  }
  return value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"");
}

function parseQuotedString(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.length < 2) {
    return undefined;
  }
  const quote = trimmed[0];
  if ((quote !== "\"" && quote !== "'" && quote !== "`") || trimmed.at(-1) !== quote) {
    return undefined;
  }
  try {
    if (quote === "`") {
      return JSON.parse(`"${trimmed.slice(1, -1).replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`) as string;
    }
    return JSON.parse(`"${trimmed.slice(1, -1).replaceAll("\"", "\\\"")}"`) as string;
  } catch {
    return undefined;
  }
}

export function locatorOrSelectorAsSelector(target: string, testIdAttribute = "data-testid"): string {
  return parseLocatorOrSelector(target, testIdAttribute).selector;
}

export function parseLocatorOrSelector(target: string, testIdAttribute = "data-testid"): ParsedLocatorOrSelector {
  const testIdMatch = /^getByTestId\s*\((.*)\)$/.exec(target.trim());
  if (!testIdMatch) {
    return { selector: target };
  }

  const testId = parseQuotedString(testIdMatch[1] ?? "");
  if (testId === undefined) {
    return { selector: target };
  }

  return {
    selector: `[${cssAttributeName(testIdAttribute)}=${cssString(testId)}]`,
    resolved: `getByTestId(${escapeWithQuotes(testId)})`
  };
}
