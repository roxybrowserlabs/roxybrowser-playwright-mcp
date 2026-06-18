import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface ApiSurfaceReport {
  interfaceName: string;
  upstreamMethods: string[];
  currentMethods: string[];
  upstreamMethodSignatures: Record<string, string[]>;
  currentMethodSignatures: Record<string, string[]>;
  missingMethods: string[];
  extraMethods: string[];
  upstreamProperties: string[];
  currentProperties: string[];
  missingProperties: string[];
  extraProperties: string[];
}

export interface PageApiReport extends ApiSurfaceReport {}

function extractInterfaceBody(source: string, interfaceName: string): string {
  const interfaceMatch = new RegExp(`export\\s+interface\\s+${interfaceName}(?:\\s*<[^>{}]+>)?\\s*(?:extends\\s+[^{}]+)?\\s*\\{`).exec(source);
  const interfaceStart = interfaceMatch?.index ?? -1;
  if (interfaceStart === -1) {
    throw new Error(`Could not find interface ${interfaceName}.`);
  }

  const bodyStart = source.indexOf("{", interfaceStart);
  if (bodyStart === -1) {
    throw new Error(`Could not find opening brace for interface ${interfaceName}.`);
  }

  let depth = 0;
  let bodyEnd = -1;
  for (let index = bodyStart; index < source.length; index += 1) {
    const character = source[index];
    if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        bodyEnd = index;
        break;
      }
    }
  }

  if (bodyEnd === -1) {
    throw new Error(`Could not find closing brace for interface ${interfaceName}.`);
  }

  return source.slice(bodyStart + 1, bodyEnd);
}

function extractMethods(source: string, interfaceName: string): string[] {
  const body = extractInterfaceBody(source, interfaceName);
  const methods = [...body.matchAll(/^\s{2}([\$A-Za-z_][\w$]*)\s*(?:<[^(\n]+>)?\(/gm)]
    .map((match) => match[1])
    .filter((method): method is string => Boolean(method));
  return [...new Set(methods)];
}

function normalizeSignature(signature: string): string {
  return signature
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\s*\|\s*/g, "|");
}

function findDeclarationEnd(source: string, start: number): number {
  let parenDepth = 0;
  let braceDepth = 0;
  let blockComment = false;
  let lineComment = false;
  let quote: "'" | "\"" | "`" | null = null;

  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    const nextCharacter = source[index + 1];

    if (lineComment) {
      if (character === "\n") {
        lineComment = false;
      }
      continue;
    }
    if (blockComment) {
      if (character === "*" && nextCharacter === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (character === "\\") {
        index += 1;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }

    if (character === "/" && nextCharacter === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === "/" && nextCharacter === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (character === "'" || character === "\"" || character === "`") {
      quote = character;
      continue;
    }
    if (character === "(") {
      parenDepth += 1;
      continue;
    }
    if (character === ")") {
      parenDepth -= 1;
      continue;
    }
    if (character === "{") {
      braceDepth += 1;
      continue;
    }
    if (character === "}") {
      braceDepth -= 1;
      continue;
    }
    if (character === ";" && parenDepth === 0 && braceDepth === 0) {
      return index + 1;
    }
  }

  return -1;
}

function extractMethodSignatures(
  source: string,
  interfaceName: string,
  methodNames?: string[]
): Record<string, string[]> {
  const body = extractInterfaceBody(source, interfaceName);
  const methodNameSet = methodNames ? new Set(methodNames) : null;
  const signatures: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
  const declarationPattern = /^\s{2}([\$A-Za-z_][\w$]*)\s*(?:<[^(\n]+>)?\(/gm;

  for (const match of body.matchAll(declarationPattern)) {
    const methodName = match[1];
    const declarationStart = match.index ?? -1;
    const declarationEnd = declarationStart === -1 ? -1 : findDeclarationEnd(body, declarationStart);
    const declaration = declarationEnd === -1 ? null : body.slice(declarationStart, declarationEnd);
    if (!methodName || !declaration || (methodNameSet && !methodNameSet.has(methodName))) {
      continue;
    }
    signatures[methodName] ??= [];
    signatures[methodName].push(normalizeSignature(declaration));
  }

  return signatures;
}

function extractProperties(source: string, interfaceName: string): string[] {
  const body = extractInterfaceBody(source, interfaceName);
  const properties = [...body.matchAll(/^\s{2}(?:readonly\s+)?([\$A-Za-z_][\w$]*)\s*:\s*[^;]+;/gm)]
    .map((match) => match[1])
    .filter((property): property is string => Boolean(property));
  return [...new Set(properties)];
}

export function generateApiSurfaceReport(interfaceName: string, options?: {
  repoRoot?: string;
  upstreamTypesPath?: string;
  currentTypesPath?: string;
}): ApiSurfaceReport {
  const repoRoot = options?.repoRoot ?? resolve(import.meta.dirname, "..");
  const upstreamTypesPath =
    options?.upstreamTypesPath ??
    resolve(repoRoot, "library/playwright/packages/playwright-core/types/types.d.ts");
  const currentTypesPath = options?.currentTypesPath ?? resolve(repoRoot, "src/types/api.ts");

  const upstreamSource = readFileSync(upstreamTypesPath, "utf8");
  const currentSource = readFileSync(currentTypesPath, "utf8");

  const upstreamMethods = extractMethods(upstreamSource, interfaceName);
  const currentMethods = extractMethods(currentSource, interfaceName);
  const upstreamMethodSignatures = extractMethodSignatures(upstreamSource, interfaceName);
  const currentMethodSignatures = extractMethodSignatures(currentSource, interfaceName);
  const upstreamProperties = extractProperties(upstreamSource, interfaceName);
  const currentProperties = extractProperties(currentSource, interfaceName);
  const currentMethodSet = new Set(currentMethods);
  const upstreamMethodSet = new Set(upstreamMethods);
  const currentPropertySet = new Set(currentProperties);
  const upstreamPropertySet = new Set(upstreamProperties);

  return {
    interfaceName,
    upstreamMethods,
    currentMethods,
    upstreamMethodSignatures,
    currentMethodSignatures,
    missingMethods: upstreamMethods.filter((method) => !currentMethodSet.has(method)),
    extraMethods: currentMethods.filter((method) => !upstreamMethodSet.has(method)),
    upstreamProperties,
    currentProperties,
    missingProperties: upstreamProperties.filter((property) => !currentPropertySet.has(property)),
    extraProperties: currentProperties.filter((property) => !upstreamPropertySet.has(property))
  };
}

export function generateApiMethodSignatureReport(interfaceName: string, methodNames: string[], options?: {
  repoRoot?: string;
  upstreamTypesPath?: string;
  currentTypesPath?: string;
}): Pick<ApiSurfaceReport, "interfaceName" | "upstreamMethodSignatures" | "currentMethodSignatures"> {
  const repoRoot = options?.repoRoot ?? resolve(import.meta.dirname, "..");
  const upstreamTypesPath =
    options?.upstreamTypesPath ??
    resolve(repoRoot, "library/playwright/packages/playwright-core/types/types.d.ts");
  const currentTypesPath = options?.currentTypesPath ?? resolve(repoRoot, "src/types/api.ts");

  const upstreamSource = readFileSync(upstreamTypesPath, "utf8");
  const currentSource = readFileSync(currentTypesPath, "utf8");

  return {
    interfaceName,
    upstreamMethodSignatures: extractMethodSignatures(upstreamSource, interfaceName, methodNames),
    currentMethodSignatures: extractMethodSignatures(currentSource, interfaceName, methodNames)
  };
}

export function generatePageApiReport(options?: {
  repoRoot?: string;
  upstreamTypesPath?: string;
  currentTypesPath?: string;
}): PageApiReport {
  return generateApiSurfaceReport("Page", options);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const reports = ["Page", "Locator", "FrameLocator", "ElementHandle", "JSHandle", "Frame"]
    .map((interfaceName) => generateApiSurfaceReport(interfaceName));
  console.log(
    JSON.stringify(
      reports.map((report) => ({
        interfaceName: report.interfaceName,
        upstreamCount: report.upstreamMethods.length,
        currentCount: report.currentMethods.length,
        missingCount: report.missingMethods.length,
        extraCount: report.extraMethods.length,
        upstreamPropertyCount: report.upstreamProperties.length,
        currentPropertyCount: report.currentProperties.length,
        missingPropertyCount: report.missingProperties.length,
        extraPropertyCount: report.extraProperties.length,
        missingMethods: report.missingMethods,
        extraMethods: report.extraMethods,
        missingProperties: report.missingProperties,
        extraProperties: report.extraProperties
      })),
      null,
      2
    )
  );
}
