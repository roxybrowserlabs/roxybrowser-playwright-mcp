#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import {
  buildExampleEnv,
  detectRequiredEndpoint,
  endpointFromEnv,
  resolveExampleTarget,
  usage
} from "./examples-runner-core.mjs";

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const envPath = resolve(rootDir, ".env");
if (existsSync(envPath)) {
  loadEnvFile(envPath);
}

async function main() {
  const argv = process.argv.slice(2);
  let openedBrowser;
  let child;
  let cleanedUp = false;

  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(usage());
    return;
  }

  const target = resolveExampleTarget(argv, { rootDir });
  const requiredEndpoint = detectRequiredEndpoint(target.scriptPath);
  const endpoints = {};

  if (requiredEndpoint && !endpointFromEnv(requiredEndpoint, process.env)) {
    const resolved = await openEndpoint(requiredEndpoint);
    openedBrowser = resolved.browser;
    endpoints[requiredEndpoint] = resolved.endpoint;
    if (resolved.sessionId) {
      endpoints.bidiSessionId = resolved.sessionId;
    }
  }

  const env = buildExampleEnv(process.env, endpoints);

  async function cleanup() {
    if (cleanedUp) {
      return;
    }
    cleanedUp = true;
    await closeOpenedBrowser(openedBrowser);
  }

  async function handleSignal(signal) {
    if (child && !child.killed) {
      child.kill(signal);
    }
    await cleanup();
    process.exit(signal === "SIGINT" ? 130 : 143);
  }

  process.once("SIGINT", () => {
    void handleSignal("SIGINT");
  });
  process.once("SIGTERM", () => {
    void handleSignal("SIGTERM");
  });

  try {
    await runPreflight(target, env, (currentChild) => {
      child = currentChild;
    });
    logRunnerSummary(target, requiredEndpoint, env);

    child = spawn(process.execPath, [target.scriptPath, ...target.scriptArgs], {
      cwd: rootDir,
      env,
      stdio: "inherit"
    });

    const exitCode = await new Promise((resolvePromise, reject) => {
      child.on("exit", (code, signal) => {
        if (signal) {
          reject(new Error(`Example terminated by signal ${signal}.`));
          return;
        }
        resolvePromise(code ?? 0);
      });
      child.on("error", reject);
    });

    process.exitCode = exitCode;
  } finally {
    child = undefined;
    await cleanup();
  }
}

async function runPreflight(target, env, onChild) {
  if (target.moduleName !== "mcp") {
    return;
  }

  console.error("[examples] building dist for MCP example...");
  await runCommand("pnpm", ["build"], env, onChild);
}

function runCommand(command, args, env, onChild) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: rootDir,
      env,
      stdio: "inherit"
    });
    onChild?.(child);
    child.on("exit", (code, signal) => {
      onChild?.(undefined);
      if (signal) {
        reject(new Error(`${command} ${args.join(" ")} terminated by signal ${signal}.`));
        return;
      }
      if (code && code !== 0) {
        reject(new Error(`${command} ${args.join(" ")} exited with ${code}.`));
        return;
      }
      resolvePromise();
    });
    child.on("error", (error) => {
      onChild?.(undefined);
      reject(error);
    });
  });
}

async function openEndpoint(protocol) {
  if (!process.env.ROXYBROWSER_API_TOKEN && !process.env.ROXY_API_TOKEN) {
    throw new Error(
      [
        `Missing ${protocol === "cdp" ? "ROXY_CDP_ENDPOINT" : "ROXY_BIDI_ENDPOINT"}.`,
        "Set it explicitly, or set ROXYBROWSER_API_TOKEN/ROXY_API_TOKEN so the runner can open a RoxyBrowser profile."
      ].join("\n")
    );
  }

  if (protocol === "bidi") {
    const { openRoxyBrowserFirefoxBidiProfile } = await import("./roxybrowser-firefox-bidi.mjs");
    const session = await openRoxyBrowserFirefoxBidiProfile({
      profileName: process.env.ROXYBROWSER_PROFILE_NAME ?? "RoxyBrowser Examples Firefox BiDi",
      windowRemark: process.env.ROXYBROWSER_WINDOW_REMARK ?? "examples bidi",
      debug: process.env.ROXYBROWSER_DEBUG === "1"
    });
    return {
      endpoint: session.endpoint,
      sessionId: session.sessionId,
      browser: {
        protocol: "bidi",
        dirId: session.dirId,
        apiPort: process.env.ROXYBROWSER_API_PORT ?? process.env.ROXY_API_PORT ?? "50000",
        apiToken: process.env.ROXYBROWSER_API_TOKEN ?? process.env.ROXY_API_TOKEN,
        workspaceId: process.env.ROXYBROWSER_WORKSPACE_ID
      }
    };
  }

  return await openRoxyBrowserCdpEndpoint();
}

async function openRoxyBrowserCdpEndpoint() {
  const { RoxyClient } = await import("../tests/helpers/roxybrowser-openai.mjs");
  const apiPort = process.env.ROXYBROWSER_API_PORT ?? process.env.ROXY_API_PORT ?? "50000";
  const apiToken = process.env.ROXYBROWSER_API_TOKEN ?? process.env.ROXY_API_TOKEN;
  const client = new RoxyClient(apiPort, apiToken);

  await client.health();
  const workspaceResponse = await client.workspace_project();
  const workspaces = extractRows(workspaceResponse.data);
  const workspaceId =
    parseNumber(process.env.ROXYBROWSER_WORKSPACE_ID)
    ?? workspaces.find((row) => row.id ?? row.workspaceId)?.id
    ?? workspaces.find((row) => row.id ?? row.workspaceId)?.workspaceId;

  if (!workspaceId) {
    throw new Error("Unable to resolve a RoxyBrowser workspace for CDP example.");
  }

  const workspace = workspaces.find((row) => row.id === workspaceId || row.workspaceId === workspaceId);
  const projectId =
    parseNumber(process.env.ROXYBROWSER_PROJECT_ID)
    ?? workspace?.project_details?.find((project) => project.projectId)?.projectId;
  const profileId = process.env.ROXYBROWSER_PROFILE_ID;
  const dirId = profileId ?? await findOrCreateCdpProfile(client, workspaceId, projectId);
  const openOptions = process.env.ROXYBROWSER_OPEN_OPTIONS_JSON
    ? JSON.parse(process.env.ROXYBROWSER_OPEN_OPTIONS_JSON)
    : {};
  const openResponse = await client.browser_open(dirId, [], openOptions);
  const endpoint = await extractCdpEndpoint(openResponse.data);

  if (endpoint) {
    return {
      endpoint,
      browser: {
        protocol: "cdp",
        dirId,
        apiPort,
        apiToken
      }
    };
  }

  const connectionInfo = await client.browser_connection_info(dirId);
  const connectionEndpoint = await extractCdpEndpoint(connectionInfo.data);
  if (connectionEndpoint) {
    return {
      endpoint: connectionEndpoint,
      browser: {
        protocol: "cdp",
        dirId,
        apiPort,
        apiToken
      }
    };
  }

  await client.browser_close(dirId).catch(() => {});
  throw new Error("RoxyBrowser profile did not expose a CDP endpoint.");
}

async function closeOpenedBrowser(openedBrowser) {
  if (!openedBrowser?.dirId) {
    return;
  }

  try {
    console.error(`[examples] closing ${openedBrowser.protocol} browser profile ${openedBrowser.dirId}...`);
    if (openedBrowser.protocol === "bidi") {
      const { closeRoxyBrowserFirefoxBidiProfile } = await import("./roxybrowser-firefox-bidi.mjs");
      await closeRoxyBrowserFirefoxBidiProfile({
        apiPort: openedBrowser.apiPort,
        apiToken: openedBrowser.apiToken,
        workspaceId: openedBrowser.workspaceId,
        dirId: openedBrowser.dirId
      });
      return;
    }

    const { RoxyClient } = await import("../tests/helpers/roxybrowser-openai.mjs");
    const client = new RoxyClient(openedBrowser.apiPort, openedBrowser.apiToken);
    await client.browser_close(openedBrowser.dirId);
  } catch (error) {
    console.error(
      `[examples] failed to close browser profile ${openedBrowser.dirId}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

async function findOrCreateCdpProfile(client, workspaceId, projectId) {
  const profileMatch = (process.env.ROXYBROWSER_PROFILE_MATCH ?? "chrome").toLowerCase();
  const listResponse = await client.browser_list(
    workspaceId,
    {
      ...(projectId ? { projectIds: String(projectId) } : {}),
      page_size: 100
    }
  );
  const profiles = extractRows(listResponse.data);
  const matched = profiles.find((profile) =>
    [
      profile.browserName,
      profile.browserType,
      profile.kernelType,
      profile.coreType,
      profile.windowName,
      profile.windowRemark
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
      .includes(profileMatch)
  );

  if (matched?.dirId) {
    return matched.dirId;
  }

  const createResponse = await client.browser_create({
    workspaceId,
    ...(projectId ? { projectId } : {}),
    windowName: process.env.ROXYBROWSER_PROFILE_NAME ?? "RoxyBrowser Examples Chrome CDP",
    windowRemark: process.env.ROXYBROWSER_WINDOW_REMARK ?? "examples cdp",
    coreType: process.env.ROXYBROWSER_CORE_TYPE ?? "Chrome",
    ...(process.env.ROXYBROWSER_CORE_VERSION ? { coreVersion: process.env.ROXYBROWSER_CORE_VERSION } : {}),
    fingerInfo: {
      portScanProtect: false
    }
  });

  if (!createResponse.data?.dirId) {
    throw new Error("RoxyBrowser profile create response did not include data.dirId.");
  }

  return createResponse.data.dirId;
}

async function extractCdpEndpoint(data) {
  const candidates = Array.isArray(data) ? data : [data];
  for (const item of candidates.filter((candidate) => candidate && typeof candidate === "object")) {
    const endpoint = [
      item.cdpWs,
      item.cdpWsEndpoint,
      item.devtoolsWs,
      item.devtoolsWebSocketUrl,
      item.webSocketDebuggerUrl,
      item.ws,
      item.webSocketUrl,
      item.wsEndpoint
    ].find((value) => typeof value === "string" && value.includes("/devtools/browser/"));

    if (endpoint) {
      return endpoint;
    }

    if (typeof item.http === "string") {
      const httpEndpoint = /^https?:\/\//.test(item.http) ? item.http : `http://${item.http}`;
      const wsEndpoint = await cdpEndpointFromHttp(httpEndpoint);
      if (wsEndpoint) {
        return wsEndpoint;
      }
    }
  }

  return undefined;
}

async function cdpEndpointFromHttp(endpoint) {
  try {
    const response = await fetch(new URL("/json/version", endpoint));
    if (!response.ok) {
      return undefined;
    }
    const payload = await response.json();
    return typeof payload.webSocketDebuggerUrl === "string"
      ? payload.webSocketDebuggerUrl
      : undefined;
  } catch {
    return undefined;
  }
}

function extractRows(data) {
  if (Array.isArray(data)) {
    return data;
  }
  if (data && typeof data === "object" && Array.isArray(data.rows)) {
    return data.rows;
  }
  return [];
}

function parseNumber(value) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function logRunnerSummary(target, requiredEndpoint, env) {
  console.error(`[examples] running ${target.examplePath}`);
  if (requiredEndpoint === "cdp") {
    console.error(`[examples] ROXY_CDP_ENDPOINT=${maskEndpoint(env.ROXY_CDP_ENDPOINT)}`);
  } else if (requiredEndpoint === "bidi") {
    console.error(`[examples] ROXY_BIDI_ENDPOINT=${maskEndpoint(env.ROXY_BIDI_ENDPOINT)}`);
  }
}

function maskEndpoint(endpoint) {
  if (!endpoint) {
    return "<unset>";
  }
  return String(endpoint)
    .replace(/\/devtools\/browser\/[^/?#]+/, "/devtools/browser/***")
    .replace(/\/session\/[^/?#]+/, "/session/***");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
