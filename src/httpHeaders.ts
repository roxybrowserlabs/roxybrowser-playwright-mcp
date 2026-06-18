export type ExtraHTTPHeaders = { [key: string]: string };

export function normalizeExtraHTTPHeaders(headers: ExtraHTTPHeaders): ExtraHTTPHeaders {
  const normalized: ExtraHTTPHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value !== "string") {
      throw new Error(
        `Expected value of header "${name}" to be String, but "${typeof value}" is found.`
      );
    }
    normalized[name] = value;
  }
  return normalized;
}

export function mergeExtraHTTPHeaders(
  ...headersList: Array<ExtraHTTPHeaders | undefined>
): ExtraHTTPHeaders {
  const merged = new Map<string, [name: string, value: string]>();
  for (const headers of headersList) {
    if (!headers) {
      continue;
    }
    for (const [name, value] of Object.entries(headers)) {
      merged.set(name.toLowerCase(), [name, value]);
    }
  }

  return Object.fromEntries(merged.values());
}
