type URLPatternLike = {
  test(input: string | URL): boolean;
  hash: string;
  hostname: string;
  password: string;
  pathname: string;
  port: string;
  protocol: string;
  search: string;
  username: string;
};

const escapedChars = new Set(["$", "^", "+", ".", "*", "(", ")", "|", "\\", "?", "{", "}", "[", "]"]);

export type URLMatch = string | RegExp | ((url: URL) => boolean) | URLPatternLike;

export function globToRegexPattern(glob: string): string {
  const tokens = ["^"];
  let inGroup = false;
  for (let index = 0; index < glob.length; ++index) {
    const character = glob[index]!;
    if (character === "\\" && index + 1 < glob.length) {
      const escaped = glob[++index]!;
      tokens.push(escapedChars.has(escaped) ? `\\${escaped}` : escaped);
      continue;
    }
    if (character === "*") {
      const charBefore = glob[index - 1];
      let starCount = 1;
      while (glob[index + 1] === "*") {
        starCount += 1;
        index += 1;
      }
      if (starCount > 1) {
        const charAfter = glob[index + 1];
        if (charAfter === "/") {
          if (charBefore === "/") {
            tokens.push("((.+/)|)");
          } else {
            tokens.push("(.*/)");
          }
          index += 1;
        } else {
          tokens.push("(.*)");
        }
      } else {
        tokens.push("([^/]*)");
      }
      continue;
    }

    switch (character) {
      case "{":
        if (inGroup) {
          throw new Error(`Invalid glob pattern ${JSON.stringify(glob)}: nested '{' is not supported`);
        }
        inGroup = true;
        tokens.push("(");
        break;
      case "}":
        if (!inGroup) {
          throw new Error(`Invalid glob pattern ${JSON.stringify(glob)}: unmatched '}'`);
        }
        inGroup = false;
        tokens.push(")");
        break;
      case ",":
        if (inGroup) {
          tokens.push("|");
          break;
        }
        tokens.push(`\\${character}`);
        break;
      default:
        tokens.push(escapedChars.has(character) ? `\\${character}` : character);
        break;
    }
  }
  if (inGroup) {
    throw new Error(`Invalid glob pattern ${JSON.stringify(glob)}: unmatched '{'`);
  }
  tokens.push("$");
  return tokens.join("");
}

export function resolveGlobToRegexPattern(
  baseURL: string | undefined,
  glob: string,
  webSocketUrl = false
): string {
  if (webSocketUrl) {
    baseURL = toWebSocketBaseURL(baseURL);
  }
  return globToRegexPattern(resolveGlobBase(baseURL, glob));
}

export function isURLPattern(value: unknown): value is URLPatternLike {
  return typeof globalThis.URLPattern === "function" && value instanceof globalThis.URLPattern;
}

export function isRegExp(value: unknown): value is RegExp {
  return value instanceof RegExp || Object.prototype.toString.call(value) === "[object RegExp]";
}

export function urlMatches(
  baseURL: string | undefined,
  urlString: string,
  match: URLMatch | undefined,
  webSocketUrl = false
): boolean {
  if (match === undefined || match === "") {
    return true;
  }
  if (typeof match === "string") {
    match = new RegExp(resolveGlobToRegexPattern(baseURL, match, webSocketUrl));
  }
  if (isRegExp(match)) {
    return match.test(urlString);
  }
  const url = parseURL(urlString);
  if (!url) {
    return false;
  }
  if (isURLPattern(match)) {
    return match.test(url.href);
  }
  if (typeof match !== "function") {
    throw new Error("url parameter should be string, RegExp, URLPattern or function");
  }
  return match(url);
}

function toWebSocketBaseURL(baseURL: string | undefined): string | undefined {
  if (baseURL && /^https?:\/\//.test(baseURL)) {
    return baseURL.replace(/^http/, "ws");
  }
  return baseURL;
}

function resolveGlobBase(baseURL: string | undefined, match: string): string {
  if (!match.startsWith("*")) {
    const tokenMap = new Map<string, string>();
    const mapToken = (original: string, replacement: string): string => {
      if (original.length === 0) {
        return "";
      }
      tokenMap.set(replacement, original);
      return replacement;
    };

    match = match.replaceAll(/\\\\\?/g, "?");
    if (
      match.startsWith("about:") ||
      match.startsWith("data:") ||
      match.startsWith("chrome:") ||
      match.startsWith("edge:") ||
      match.startsWith("file:")
    ) {
      return match;
    }

    const relativePath = match
      .split("/")
      .map((token, index) => {
        if (token === "." || token === ".." || token === "") {
          return token;
        }
        if (index === 0 && token.endsWith(":")) {
          if (token.includes("*") || token.includes("{")) {
            return mapToken(token, "http:");
          }
          return token;
        }
        const questionIndex = token.indexOf("?");
        if (questionIndex === -1) {
          return mapToken(token, `$_${index}_$`);
        }
        const newPrefix = mapToken(token.substring(0, questionIndex), `$_${index}_$`);
        const newSuffix = mapToken(token.substring(questionIndex), `?$_${index}_$`);
        return newPrefix + newSuffix;
      })
      .join("/");

    const result = resolveBaseURL(baseURL, relativePath);
    let resolved = result.resolved;
    for (const [token, original] of tokenMap) {
      const normalize = result.caseInsensitivePart?.includes(token);
      resolved = resolved.replace(token, normalize ? original.toLowerCase() : original);
    }
    match = resolved;
  }
  return match;
}

function resolveBaseURL(baseURL: string | undefined, givenURL: string): {
  resolved: string;
  caseInsensitivePart?: string;
} {
  try {
    const url = new URL(givenURL, baseURL);
    return {
      resolved: url.toString(),
      caseInsensitivePart: url.origin
    };
  } catch {
    return {
      resolved: givenURL
    };
  }
}

function parseURL(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}
