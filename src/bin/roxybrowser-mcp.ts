#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import dotenv from "dotenv";
import { resolveMcpDeviceContextOptions } from "../mcp/deviceDescriptors.js";
import { startRoxyBrowserMcpHttp, startRoxyBrowserMcpStdio } from "../mcp/index.js";
import type {
  CreateRoxyBrowserMcpServerOptions,
  SnapshotMode,
  StartRoxyBrowserMcpHttpOptions,
  StartRoxyBrowserMcpStdioOptions
} from "../mcp/index.js";
import type { BrowserContextOptions } from "../types/options.js";
import type { ConsoleMessageLevel } from "../mcp/types.js";

type CliTransport = "stdio" | "http";
type CliCapability = NonNullable<CreateRoxyBrowserMcpServerOptions["capabilities"]>[number];
type CliCodegen = NonNullable<CreateRoxyBrowserMcpServerOptions["codegen"]>;
const SUPPORTED_CAPABILITIES = new Set<CliCapability>(["storage", "devtools", "network", "pdf", "testing", "vision"]);
const LEGACY_CAPABILITY_ALIASES = new Map<string, CliCapability>([
  ["tracing", "devtools"]
]);

interface CliOptions {
  transport: CliTransport;
  host?: string;
  port?: number;
  path?: string;
  allowedHosts?: string[];
  artifactsDir?: string;
  downloadsDir?: string;
  screenshotsDir?: string;
  snapshotsDir?: string;
  tracesDir?: string;
  videosDir?: string;
  networkDir?: string;
  consoleDir?: string;
  scriptsDir?: string;
  tempDir?: string;
  initPage?: string[];
  initScript?: string[];
  snapshotMode?: SnapshotMode;
  capabilities?: CliCapability[];
  consoleLevel?: ConsoleMessageLevel;
  codegen?: CliCodegen;
  outputMaxSize?: number;
  testIdAttribute?: string;
  network?: CreateRoxyBrowserMcpServerOptions["network"];
  imageResponses?: CreateRoxyBrowserMcpServerOptions["imageResponses"];
  contextOptions?: BrowserContextOptions;
  timeouts?: CreateRoxyBrowserMcpServerOptions["timeouts"];
  viewport?: CreateRoxyBrowserMcpServerOptions["viewport"];
  secrets?: Record<string, string>;
}

type McpCliEnv = Partial<Record<
  | "PLAYWRIGHT_MCP_HOST"
  | "PLAYWRIGHT_MCP_PORT"
  | "PLAYWRIGHT_MCP_ALLOWED_HOSTS"
  | "PLAYWRIGHT_MCP_OUTPUT_DIR"
  | "PLAYWRIGHT_MCP_OUTPUT_MAX_SIZE"
  | "PLAYWRIGHT_MCP_TEST_ID_ATTRIBUTE"
  | "PLAYWRIGHT_MCP_ALLOWED_ORIGINS"
  | "PLAYWRIGHT_MCP_BLOCKED_ORIGINS"
  | "PLAYWRIGHT_MCP_BLOCK_SERVICE_WORKERS"
  | "PLAYWRIGHT_MCP_CAPS"
  | "PLAYWRIGHT_MCP_CODEGEN"
  | "PLAYWRIGHT_MCP_CONSOLE_LEVEL"
  | "PLAYWRIGHT_MCP_DEVICE"
  | "PLAYWRIGHT_MCP_GRANT_PERMISSIONS"
  | "PLAYWRIGHT_MCP_IGNORE_HTTPS_ERRORS"
  | "PLAYWRIGHT_MCP_INIT_PAGE"
  | "PLAYWRIGHT_MCP_INIT_SCRIPT"
  | "PLAYWRIGHT_MCP_IMAGE_RESPONSES"
  | "PLAYWRIGHT_MCP_MOBILE"
  | "PLAYWRIGHT_MCP_SECRETS_FILE"
  | "PLAYWRIGHT_MCP_STORAGE_STATE"
  | "PLAYWRIGHT_MCP_TIMEOUT_ACTION"
  | "PLAYWRIGHT_MCP_TIMEOUT_NAVIGATION"
  | "PLAYWRIGHT_MCP_TIMEOUT_SETTLE"
  | "PLAYWRIGHT_MCP_USER_AGENT"
  | "PLAYWRIGHT_MCP_VIEWPORT_SIZE",
  string
>>;

export function parseCliOptions(argv: string[], env: McpCliEnv = process.env): CliOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      transport: { type: "string" },
      host: { type: "string" },
      port: { type: "string" },
      path: { type: "string" },
      "allowed-hosts": { type: "string" },
      "artifacts-dir": { type: "string" },
      "allowed-origins": { type: "string" },
      "blocked-origins": { type: "string" },
      "block-service-workers": { type: "boolean" },
      "output-dir": { type: "string" },
      "output-max-size": { type: "string" },
      "test-id-attribute": { type: "string" },
      "downloads-dir": { type: "string" },
      "screenshots-dir": { type: "string" },
      "snapshots-dir": { type: "string" },
      "traces-dir": { type: "string" },
      "videos-dir": { type: "string" },
      "network-dir": { type: "string" },
      "console-dir": { type: "string" },
      "scripts-dir": { type: "string" },
      "temp-dir": { type: "string" },
      "init-page": { type: "string", multiple: true },
      "init-script": { type: "string", multiple: true },
      "image-responses": { type: "string" },
      codegen: { type: "string" },
      "console-level": { type: "string" },
      "snapshot-mode": { type: "string" },
      "grant-permissions": { type: "string" },
      "ignore-https-errors": { type: "boolean" },
      secrets: { type: "string" },
      caps: { type: "string" },
      vision: { type: "boolean" },
      device: { type: "string" },
      mobile: { type: "boolean" },
      "timeout-action": { type: "string" },
      "timeout-navigation": { type: "string" },
      "timeout-settle": { type: "string" },
      "user-agent": { type: "string" },
      "storage-state": { type: "string" },
      "viewport-size": { type: "string" }
    },
    allowPositionals: false
  });

  const transport = (values.transport ?? "stdio") as string;
  if (transport !== "stdio" && transport !== "http") {
    throw new Error(`Unsupported transport "${transport}". Expected "stdio" or "http".`);
  }

  const snapshotMode = values["snapshot-mode"];
  if (
    snapshotMode !== undefined
    && snapshotMode !== "full"
    && snapshotMode !== "none"
  ) {
    throw new Error(`Unsupported snapshot mode "${snapshotMode}". Expected "full" or "none".`);
  }

  const consoleLevel = parseConsoleLevel(values["console-level"] ?? env.PLAYWRIGHT_MCP_CONSOLE_LEVEL);
  const codegen = parseCodegen(values.codegen ?? env.PLAYWRIGHT_MCP_CODEGEN);
  const outputMaxSize = parseOptionalInteger(values["output-max-size"] ?? env.PLAYWRIGHT_MCP_OUTPUT_MAX_SIZE, "output-max-size");
  const testIdAttribute = parseOptionalString(values["test-id-attribute"] ?? env.PLAYWRIGHT_MCP_TEST_ID_ATTRIBUTE);
  const host = values.host ?? env.PLAYWRIGHT_MCP_HOST;
  const allowedHosts = parseCommaListOption(values["allowed-hosts"] ?? env.PLAYWRIGHT_MCP_ALLOWED_HOSTS);
  const portValue = values.port ?? env.PLAYWRIGHT_MCP_PORT;
  const port =
    portValue === undefined ? undefined : Number.parseInt(portValue, 10);
  if (portValue !== undefined && Number.isNaN(port)) {
    throw new Error(`Invalid port "${portValue}". Expected an integer.`);
  }
  const artifactsDir = values["artifacts-dir"] ?? values["output-dir"] ?? env.PLAYWRIGHT_MCP_OUTPUT_DIR;
  const capabilities = parseCapabilities(values.caps ?? env.PLAYWRIGHT_MCP_CAPS);
  if (values.vision === true) {
    capabilities.push("vision");
  }
  const allowedOrigins = parseSemicolonListOption(values["allowed-origins"] ?? env.PLAYWRIGHT_MCP_ALLOWED_ORIGINS);
  const blockedOrigins = parseSemicolonListOption(values["blocked-origins"] ?? env.PLAYWRIGHT_MCP_BLOCKED_ORIGINS);
  const network = allowedOrigins !== undefined || blockedOrigins !== undefined
    ? {
        ...(allowedOrigins !== undefined ? { allowedOrigins } : {}),
        ...(blockedOrigins !== undefined ? { blockedOrigins } : {})
      }
    : undefined;
  const imageResponses = parseImageResponses(values["image-responses"] ?? env.PLAYWRIGHT_MCP_IMAGE_RESPONSES);
  const initPage = parseStringListOption(values["init-page"], env.PLAYWRIGHT_MCP_INIT_PAGE);
  const initScript = parseStringListOption(values["init-script"], env.PLAYWRIGHT_MCP_INIT_SCRIPT);
  const secrets = parseSecrets(values.secrets ?? env.PLAYWRIGHT_MCP_SECRETS_FILE);
  const timeouts = parseTimeoutOptions(values, env);
  const viewport = parseViewportSize(values["viewport-size"] ?? env.PLAYWRIGHT_MCP_VIEWPORT_SIZE);
  const userAgent = values["user-agent"] ?? env.PLAYWRIGHT_MCP_USER_AGENT;
  const storageState = values["storage-state"] ?? env.PLAYWRIGHT_MCP_STORAGE_STATE;
  const permissions = parseCommaListOption(values["grant-permissions"] ?? env.PLAYWRIGHT_MCP_GRANT_PERMISSIONS);
  const ignoreHTTPSErrors = values["ignore-https-errors"] === true
    || parseEnvBoolean(env.PLAYWRIGHT_MCP_IGNORE_HTTPS_ERRORS) === true;
  const blockServiceWorkers = values["block-service-workers"] === true
    || parseEnvBoolean(env.PLAYWRIGHT_MCP_BLOCK_SERVICE_WORKERS) === true;
  const envMobile = parseEnvBoolean(env.PLAYWRIGHT_MCP_MOBILE);
  const envContextOptions = resolveMcpDeviceContextOptions({
    ...(envMobile !== undefined ? { mobile: envMobile } : {}),
    ...(env.PLAYWRIGHT_MCP_DEVICE !== undefined ? { device: env.PLAYWRIGHT_MCP_DEVICE } : {})
  });
  const cliDevice = typeof values.device === "string" ? values.device : undefined;
  const cliContextOptions = resolveMcpDeviceContextOptions({
    ...(values.mobile === true ? { mobile: true } : {}),
    ...(cliDevice !== undefined ? { device: cliDevice } : {})
  });
  const contextOptions = {
    ...(envContextOptions ?? {}),
    ...(cliContextOptions ?? {}),
    ...(ignoreHTTPSErrors ? { ignoreHTTPSErrors: true } : {}),
    ...(permissions !== undefined ? { permissions } : {}),
    ...(blockServiceWorkers ? { serviceWorkers: "block" as const } : {}),
    ...(viewport !== undefined ? { viewport } : {}),
    ...(userAgent !== undefined ? { userAgent } : {}),
    ...(storageState !== undefined ? { storageState } : {})
  };
  const hasContextOptions = Object.keys(contextOptions).length > 0;

  return {
    transport,
    ...(host !== undefined ? { host } : {}),
    ...(port !== undefined ? { port } : {}),
    ...(allowedHosts !== undefined ? { allowedHosts } : {}),
    ...(values.path !== undefined ? { path: values.path } : {}),
    ...(artifactsDir !== undefined ? { artifactsDir } : {}),
    ...(values["downloads-dir"] !== undefined ? { downloadsDir: values["downloads-dir"] } : {}),
    ...(values["screenshots-dir"] !== undefined ? { screenshotsDir: values["screenshots-dir"] } : {}),
    ...(values["snapshots-dir"] !== undefined ? { snapshotsDir: values["snapshots-dir"] } : {}),
    ...(values["traces-dir"] !== undefined ? { tracesDir: values["traces-dir"] } : {}),
    ...(values["videos-dir"] !== undefined ? { videosDir: values["videos-dir"] } : {}),
    ...(values["network-dir"] !== undefined ? { networkDir: values["network-dir"] } : {}),
    ...(values["console-dir"] !== undefined ? { consoleDir: values["console-dir"] } : {}),
    ...(values["scripts-dir"] !== undefined ? { scriptsDir: values["scripts-dir"] } : {}),
    ...(values["temp-dir"] !== undefined ? { tempDir: values["temp-dir"] } : {}),
    ...(initPage !== undefined ? { initPage } : {}),
    ...(initScript !== undefined ? { initScript } : {}),
    ...(secrets !== undefined ? { secrets } : {}),
    ...(imageResponses !== undefined ? { imageResponses } : {}),
    ...(codegen !== undefined ? { codegen } : {}),
    ...(outputMaxSize !== undefined ? { outputMaxSize } : {}),
    ...(testIdAttribute !== undefined ? { testIdAttribute } : {}),
    ...(consoleLevel !== undefined ? { consoleLevel } : {}),
    ...(snapshotMode !== undefined ? { snapshotMode: snapshotMode as SnapshotMode } : {}),
    ...(capabilities.length ? { capabilities } : {}),
    ...(network !== undefined ? { network } : {}),
    ...(hasContextOptions ? { contextOptions } : {}),
    ...(timeouts !== undefined ? { timeouts } : {}),
    ...(viewport !== undefined ? { viewport } : {})
  };
}

function parseCapabilities(value: string | undefined): CliCapability[] {
  if (value === undefined) {
    return [];
  }
  const capabilities: CliCapability[] = [];
  for (const entry of value.split(",")) {
    const capability = entry.trim();
    if (!capability) {
      continue;
    }
    const normalizedCapability = LEGACY_CAPABILITY_ALIASES.get(capability) ?? capability;
    if (!SUPPORTED_CAPABILITIES.has(normalizedCapability as CliCapability)) {
      throw new Error(`Unsupported capability "${capability}".`);
    }
    if (!capabilities.includes(normalizedCapability as CliCapability)) {
      capabilities.push(normalizedCapability as CliCapability);
    }
  }
  return capabilities;
}

function parseStringListOption(value: string[] | undefined, envValue: string | undefined): string[] | undefined {
  if (value !== undefined) {
    return value;
  }
  return envValue ? [envValue.trim()] : undefined;
}

function parseSecrets(path: string | undefined): Record<string, string> | undefined {
  if (path === undefined) {
    return undefined;
  }
  return dotenv.parse(readFileSync(path, "utf8"));
}

function parseSemicolonListOption(value: string | boolean | undefined): string[] | undefined {
  if (value === undefined || typeof value !== "string") {
    return undefined;
  }
  const entries = value.split(";").map((entry) => entry.trim()).filter(Boolean);
  return entries.length ? entries : undefined;
}

function parseCommaListOption(value: string | boolean | undefined): string[] | undefined {
  if (value === undefined || typeof value !== "string") {
    return undefined;
  }
  const entries = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  return entries.length ? entries : undefined;
}

function parseImageResponses(value: string | undefined): CreateRoxyBrowserMcpServerOptions["imageResponses"] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === "omit") {
    return "omit";
  }
  if (value === "allow") {
    return "include";
  }
  throw new Error(`Unsupported image-responses "${value}". Expected "allow" or "omit".`);
}

function parseConsoleLevel(value: string | undefined): ConsoleMessageLevel | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === "error" || value === "warning" || value === "info" || value === "debug") {
    return value;
  }
  throw new Error(`Unsupported console-level "${value}". Expected "error", "warning", "info", or "debug".`);
}

function parseCodegen(value: string | undefined): CliCodegen | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === "none" || value === "typescript") {
    return value;
  }
  throw new Error(`Unsupported codegen "${value}". Expected "none" or "typescript".`);
}

function parseOptionalString(value: string | boolean | undefined): string | undefined {
  if (value === undefined || typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function parseTimeoutOptions(values: {
  "timeout-action"?: string | boolean;
  "timeout-navigation"?: string | boolean;
  "timeout-settle"?: string | boolean;
}, env: McpCliEnv): CreateRoxyBrowserMcpServerOptions["timeouts"] | undefined {
  const action = parseOptionalInteger(
    values["timeout-action"] ?? env.PLAYWRIGHT_MCP_TIMEOUT_ACTION,
    "timeout-action"
  );
  const navigation = parseOptionalInteger(
    values["timeout-navigation"] ?? env.PLAYWRIGHT_MCP_TIMEOUT_NAVIGATION,
    "timeout-navigation"
  );
  const settle = parseOptionalInteger(
    values["timeout-settle"] ?? env.PLAYWRIGHT_MCP_TIMEOUT_SETTLE,
    "timeout-settle"
  );
  if (action === undefined && navigation === undefined && settle === undefined) {
    return undefined;
  }
  return {
    ...(action !== undefined ? { action } : {}),
    ...(navigation !== undefined ? { navigation } : {}),
    ...(settle !== undefined ? { settle } : {})
  };
}

function parseOptionalInteger(value: string | boolean | undefined, optionName: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`Invalid ${optionName} "${String(value)}". Expected an integer.`);
  }
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || String(parsed) !== value) {
    throw new Error(`Invalid ${optionName} "${value}". Expected an integer.`);
  }
  return parsed;
}

function parseEnvBoolean(value: string | undefined): boolean | undefined {
  if (value === "true" || value === "1") {
    return true;
  }
  if (value === "false" || value === "0") {
    return false;
  }
  return undefined;
}

function parseViewportSize(value: string | undefined): CreateRoxyBrowserMcpServerOptions["viewport"] | undefined {
  if (value === undefined) {
    return undefined;
  }
  const match = /^(\d+)x(\d+)$/.exec(value);
  if (!match) {
    throw new Error(`Invalid viewport-size "${value}". Expected "<width>x<height>".`);
  }
  const width = Number.parseInt(match[1]!, 10);
  const height = Number.parseInt(match[2]!, 10);
  if (width <= 0 || height <= 0) {
    throw new Error(`Invalid viewport-size "${value}". Expected "<width>x<height>".`);
  }
  return { width, height };
}

export function sharedOptions(options: CliOptions): Pick<
  StartRoxyBrowserMcpStdioOptions,
  | "artifactsDir"
  | "capabilities"
  | "contextOptions"
  | "downloadsDir"
  | "screenshotsDir"
  | "snapshotsDir"
  | "tracesDir"
  | "videosDir"
  | "networkDir"
  | "network"
  | "consoleDir"
  | "consoleLevel"
  | "codegen"
  | "imageResponses"
  | "initPage"
  | "initScript"
  | "outputMaxSize"
  | "scriptsDir"
  | "secrets"
  | "snapshotMode"
  | "tempDir"
  | "testIdAttribute"
  | "timeouts"
  | "viewport"
> {
  return {
    ...(options.artifactsDir !== undefined ? { artifactsDir: options.artifactsDir } : {}),
    ...(options.downloadsDir !== undefined ? { downloadsDir: options.downloadsDir } : {}),
    ...(options.screenshotsDir !== undefined ? { screenshotsDir: options.screenshotsDir } : {}),
    ...(options.snapshotsDir !== undefined ? { snapshotsDir: options.snapshotsDir } : {}),
    ...(options.tracesDir !== undefined ? { tracesDir: options.tracesDir } : {}),
    ...(options.videosDir !== undefined ? { videosDir: options.videosDir } : {}),
    ...(options.networkDir !== undefined ? { networkDir: options.networkDir } : {}),
    ...(options.consoleDir !== undefined ? { consoleDir: options.consoleDir } : {}),
    ...(options.consoleLevel !== undefined ? { consoleLevel: options.consoleLevel } : {}),
    ...(options.codegen !== undefined ? { codegen: options.codegen } : {}),
    ...(options.network !== undefined ? { network: options.network } : {}),
    ...(options.imageResponses !== undefined ? { imageResponses: options.imageResponses } : {}),
    ...(options.outputMaxSize !== undefined ? { outputMaxSize: options.outputMaxSize } : {}),
    ...(options.testIdAttribute !== undefined ? { testIdAttribute: options.testIdAttribute } : {}),
    ...(options.scriptsDir !== undefined ? { scriptsDir: options.scriptsDir } : {}),
    ...(options.tempDir !== undefined ? { tempDir: options.tempDir } : {}),
    ...(options.initPage !== undefined ? { initPage: options.initPage } : {}),
    ...(options.initScript !== undefined ? { initScript: options.initScript } : {}),
    ...(options.secrets !== undefined ? { secrets: options.secrets } : {}),
    ...(options.snapshotMode !== undefined ? { snapshotMode: options.snapshotMode } : {}),
    ...(options.capabilities !== undefined ? { capabilities: options.capabilities } : {}),
    ...(options.contextOptions !== undefined ? { contextOptions: options.contextOptions } : {}),
    ...(options.timeouts !== undefined ? { timeouts: options.timeouts } : {}),
    ...(options.viewport !== undefined ? { viewport: options.viewport } : {})
  } satisfies Partial<CreateRoxyBrowserMcpServerOptions>;
}

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));

  if (options.transport === "http") {
    const httpOptions: StartRoxyBrowserMcpHttpOptions = {
      port: options.port ?? 3333,
      ...(options.host !== undefined ? { host: options.host } : {}),
      ...(options.path !== undefined ? { path: options.path } : {}),
      ...(options.allowedHosts !== undefined ? { allowedHosts: options.allowedHosts } : {}),
      ...sharedOptions(options)
    };
    const bundle = await startRoxyBrowserMcpHttp(httpOptions);
    const host = httpOptions.host ?? "127.0.0.1";
    const path = httpOptions.path ?? "/mcp";
    console.error(`RoxyBrowser MCP HTTP server listening at http://${host}:${httpOptions.port}${path}`);

    const close = async (): Promise<void> => {
      await bundle.close();
      process.exitCode = 0;
    };

    process.once("SIGINT", () => void close());
    process.once("SIGTERM", () => void close());
    return;
  }

  await startRoxyBrowserMcpStdio(sharedOptions(options));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
