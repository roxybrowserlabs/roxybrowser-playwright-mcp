import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface PageApiReport {
  upstreamMethods: string[];
  currentMethods: string[];
  missingMethods: string[];
  extraMethods: string[];
  upstreamProperties: string[];
  currentProperties: string[];
  missingProperties: string[];
  extraProperties: string[];
}

function extractInterfaceBody(source: string, interfaceName: string): string {
  const interfaceStart = source.indexOf(`export interface ${interfaceName} {`);
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

function extractProperties(source: string, interfaceName: string): string[] {
  const body = extractInterfaceBody(source, interfaceName);
  const properties = [...body.matchAll(/^\s{2}(?:readonly\s+)?([\$A-Za-z_][\w$]*)\s*:\s*[^;]+;/gm)]
    .map((match) => match[1])
    .filter((property): property is string => Boolean(property));
  return [...new Set(properties)];
}

export function generatePageApiReport(options?: {
  repoRoot?: string;
  upstreamTypesPath?: string;
  currentTypesPath?: string;
}): PageApiReport {
  const repoRoot = options?.repoRoot ?? resolve(import.meta.dirname, "..");
  const upstreamTypesPath =
    options?.upstreamTypesPath ??
    resolve(repoRoot, "library/playwright/packages/playwright-core/types/types.d.ts");
  const currentTypesPath = options?.currentTypesPath ?? resolve(repoRoot, "src/types/api.ts");

  const upstreamSource = readFileSync(upstreamTypesPath, "utf8");
  const currentSource = readFileSync(currentTypesPath, "utf8");

  const upstreamMethods = extractMethods(upstreamSource, "Page");
  const currentMethods = extractMethods(currentSource, "Page");
  const upstreamProperties = extractProperties(upstreamSource, "Page");
  const currentProperties = extractProperties(currentSource, "Page");
  const currentMethodSet = new Set(currentMethods);
  const upstreamMethodSet = new Set(upstreamMethods);
  const currentPropertySet = new Set(currentProperties);
  const upstreamPropertySet = new Set(upstreamProperties);

  return {
    upstreamMethods,
    currentMethods,
    missingMethods: upstreamMethods.filter((method) => !currentMethodSet.has(method)),
    extraMethods: currentMethods.filter((method) => !upstreamMethodSet.has(method)),
    upstreamProperties,
    currentProperties,
    missingProperties: upstreamProperties.filter((property) => !currentPropertySet.has(property)),
    extraProperties: currentProperties.filter((property) => !upstreamPropertySet.has(property))
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const report = generatePageApiReport();
  console.log(
    JSON.stringify(
      {
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
      },
      null,
      2
    )
  );
}
