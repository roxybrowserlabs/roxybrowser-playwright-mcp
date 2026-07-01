import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export const endpointEnv = {
  cdp: ["ROXY_CDP_ENDPOINT", "ROXY_CDP_WS_ENDPOINT"],
  bidi: ["ROXY_BIDI_ENDPOINT", "ROXY_BIDI_WS_ENDPOINT"]
};

export function resolveExampleTarget(argv, options = {}) {
  const rootDir = options.rootDir ?? process.cwd();
  const exists = options.existsSync ?? existsSync;
  const separatorIndex = argv.indexOf("--");
  const targetArgs = separatorIndex >= 0 ? argv.slice(0, separatorIndex) : argv;
  const scriptArgs = separatorIndex >= 0 ? argv.slice(separatorIndex + 1) : [];

  if (targetArgs.length < 2) {
    throw new Error(usage());
  }

  const normalizedSegments = targetArgs.flatMap((part) => part.split("/").filter(Boolean));
  const last = normalizedSegments.at(-1);
  if (!last) {
    throw new Error(usage());
  }

  const scriptSegments = [
    ...normalizedSegments.slice(0, -1),
    last.endsWith(".mjs") ? last : `${last}.mjs`
  ];
  const scriptPath = resolve(rootDir, "examples", ...scriptSegments);

  if (!exists(scriptPath)) {
    throw new Error(`Example not found: examples/${scriptSegments.join("/")}`);
  }

  return {
    moduleName: normalizedSegments[0],
    scriptName: scriptSegments.at(-1),
    examplePath: `examples/${scriptSegments.join("/")}`,
    scriptPath,
    scriptArgs
  };
}

export function detectRequiredEndpoint(scriptPath, options = {}) {
  const read = options.readFileSync ?? readFileSync;
  if (scriptPath.includes("/examples/repro/bidi/")) {
    return "bidi";
  }
  const source = read(scriptPath, "utf8");
  if (source.includes("ROXY_BIDI_ENDPOINT")) {
    return "bidi";
  }
  if (source.includes("ROXY_CDP_ENDPOINT") || source.includes("requiredCdpEndpoint")) {
    return "cdp";
  }
  return undefined;
}

export function endpointFromEnv(protocol, env) {
  return endpointEnv[protocol].map((name) => env[name]).find(Boolean);
}

export function buildExampleEnv(env, endpoints = {}) {
  const next = { ...env };

  const cdpEndpoint = endpoints.cdp ?? endpointFromEnv("cdp", env);
  if (cdpEndpoint) {
    next.ROXY_CDP_ENDPOINT = cdpEndpoint;
    next.ROXY_CDP_WS_ENDPOINT = cdpEndpoint;
  }

  const bidiEndpoint = endpoints.bidi ?? endpointFromEnv("bidi", env);
  if (bidiEndpoint) {
    next.ROXY_BIDI_ENDPOINT = bidiEndpoint;
    next.ROXY_BIDI_WS_ENDPOINT = bidiEndpoint;
  }

  if (endpoints.bidiSessionId) {
    next.ROXY_BIDI_SESSION_ID = endpoints.bidiSessionId;
  }

  return next;
}

export function usage() {
  return [
    "Usage: pnpm examples <module> <script> [-- <script args>]",
    "",
    "Examples:",
    "  pnpm examples mcp launch-stdio",
    "  pnpm examples page connect-over-cdp",
    "  pnpm examples repro bidi 01-click-alert-blocks"
  ].join("\n");
}
