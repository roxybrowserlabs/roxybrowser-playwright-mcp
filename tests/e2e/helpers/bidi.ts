import { afterAll } from "vitest";
import { firefox } from "../../../src/index.js";
import type { Browser, BrowserContext, Page } from "../../../src/types/api.js";

const FIREFOX_EXECUTABLE =
  process.env.ROXY_BIDI_EXECUTABLE_PATH ?? "/Applications/Firefox.app/Contents/MacOS/firefox";
const BIDI_WS_ENDPOINT = process.env.ROXY_BIDI_WS_ENDPOINT;
const BIDI_SESSION_ID = process.env.ROXY_BIDI_SESSION_ID;
const ROXYBROWSER_API_PORT = process.env.ROXYBROWSER_API_PORT ?? process.env.ROXY_API_PORT ?? "50000";
const ROXYBROWSER_API_TOKEN = process.env.ROXYBROWSER_API_TOKEN ?? process.env.ROXY_API_TOKEN;
const ROXYBROWSER_WORKSPACE_ID = process.env.ROXYBROWSER_WORKSPACE_ID;
const ROXYBROWSER_PROJECT_ID = process.env.ROXYBROWSER_PROJECT_ID;
const ROXYBROWSER_PROFILE_ID = process.env.ROXYBROWSER_PROFILE_ID;
const ROXYBROWSER_PROFILE_NAME = process.env.ROXYBROWSER_PROFILE_NAME ?? "RoxyBrowser Firefox BiDi E2E";
const ROXYBROWSER_PROFILE_MATCH = process.env.ROXYBROWSER_PROFILE_MATCH ?? "firefox";
const ROXYBROWSER_DEBUG = process.env.ROXYBROWSER_DEBUG === "1";
const ROXYBROWSER_API_RETRIES = parseNumber(process.env.ROXYBROWSER_API_RETRIES) ?? 2;
const ROXYBROWSER_FORCE_OPEN = process.env.ROXYBROWSER_FORCE_OPEN !== "0";

let usesExternalBidiEndpoint = false;
let externalBidiBrowser: Browser | undefined;
let externalBidiBrowserKey: string | undefined;

afterAll(async () => {
  await closeExternalBidiBrowser();
});

function bidiHumanOptions() {
  return {
    hoverBeforeClickMs: 0,
    clickHoldMs: 0,
    typingDelayMs: 0,
    typingVarianceMs: 0
  };
}

export async function openBidiBrowser(): Promise<Browser> {
  const roxyBrowserEndpoint = BIDI_WS_ENDPOINT
    ? toBidiWsEndpoint(BIDI_WS_ENDPOINT)
    : await resolveRoxyBrowserBidiEndpoint();

  if (roxyBrowserEndpoint) {
    usesExternalBidiEndpoint = true;

    const browserKey = `${roxyBrowserEndpoint}#${BIDI_SESSION_ID ?? ""}`;
    if (externalBidiBrowser && externalBidiBrowserKey === browserKey) {
      return externalBidiBrowser;
    }

    await closeExternalBidiBrowser();
    externalBidiBrowserKey = browserKey;
    externalBidiBrowser = await firefox.connect({
      browserName: "firefox",
      protocol: "bidi",
      wsEndpoint: roxyBrowserEndpoint,
      ...(BIDI_SESSION_ID ? { sessionId: BIDI_SESSION_ID } : {}),
      human: bidiHumanOptions()
    });
    return externalBidiBrowser;
  }

  usesExternalBidiEndpoint = false;

  return firefox.launch({
    headless: true,
    executablePath: FIREFOX_EXECUTABLE,
    human: bidiHumanOptions()
  });
}

interface RoxyClient {
  health(): Promise<RoxyResponse>;
  workspace_project(): Promise<RoxyResponse>;
  browser_list(
    workspaceId: number,
    filters?: Record<string, unknown> | string,
    pageIndex?: number,
    pageSize?: number
  ): Promise<RoxyResponse>;
  browser_detail(workspaceId: number, dirId: string): Promise<RoxyResponse>;
  browser_create(data: Record<string, unknown>): Promise<RoxyResponse>;
  browser_open(
    dirId: string,
    args?: string[],
    options?: Record<string, unknown>
  ): Promise<RoxyResponse>;
  browser_connection_info(dirIds?: string): Promise<RoxyResponse>;
}

interface RoxyResponse {
  code?: number;
  data?: unknown;
  msg?: string;
}

interface RoxyProfile {
  dirId?: string;
  windowName?: string;
  windowRemark?: string;
  browserName?: string;
  browserType?: string;
  kernelType?: string;
  coreType?: string;
  [key: string]: unknown;
}

interface RoxyWorkspace {
  id?: number;
  workspaceId?: number;
  project_details?: Array<{ projectId?: number }>;
}

async function resolveRoxyBrowserBidiEndpoint(): Promise<string | undefined> {
  if (!ROXYBROWSER_API_TOKEN) {
    return undefined;
  }

  const { RoxyClient } = await import("../../../scripts/roxybrowser-openai.mjs");
  const client = new RoxyClient(ROXYBROWSER_API_PORT, ROXYBROWSER_API_TOKEN) as RoxyClient;
  debugRoxyBrowser(`Using RoxyBrowser API on 127.0.0.1:${ROXYBROWSER_API_PORT}.`);
  await callRoxy("RoxyBrowser API health check", () => client.health());

  const workspace = await resolveRoxyWorkspace(client);
  const workspaceId = workspace.id ?? workspace.workspaceId;

  if (!workspaceId) {
    throw new Error("Unable to resolve a RoxyBrowser workspaceId.");
  }

  debugRoxyBrowser(`Resolved workspaceId=${workspaceId}.`);

  const projectId = parseNumber(ROXYBROWSER_PROJECT_ID)
    ?? workspace.project_details?.find((project) => project.projectId)?.projectId;
  debugRoxyBrowser(`Resolved projectId=${projectId ?? "none"}.`);

  const profile = await resolveRoxyFirefoxProfile(client, workspaceId, projectId);
  const dirId = profile.dirId;

  if (!dirId) {
    throw new Error("Unable to resolve a RoxyBrowser profile dirId.");
  }

  return await openRoxyBrowserBidiEndpoint(client, workspaceId, dirId);
}

async function resolveRoxyWorkspace(client: RoxyClient): Promise<RoxyWorkspace> {
  const workspaceId = parseNumber(ROXYBROWSER_WORKSPACE_ID);

  if (workspaceId) {
    return { id: workspaceId };
  }

  const response = await callRoxy("RoxyBrowser workspace lookup", () => client.workspace_project());
  const rows = extractRows<RoxyWorkspace>(response.data);
  const workspace = rows.find((row) => row.id ?? row.workspaceId) ?? rows[0];

  if (!workspace) {
    throw new Error("RoxyBrowser API returned no workspaces.");
  }

  return workspace;
}

async function resolveRoxyFirefoxProfile(
  client: RoxyClient,
  workspaceId: number,
  projectId: number | undefined
): Promise<RoxyProfile> {
  if (ROXYBROWSER_PROFILE_ID) {
    return { dirId: ROXYBROWSER_PROFILE_ID };
  }

  const response = await callRoxy(
    "RoxyBrowser profile list lookup",
    () => client.browser_list(
      workspaceId,
      {
        ...(projectId ? { projectIds: String(projectId) } : {}),
        page_size: 100
      }
    )
  );

  const profiles = await hydrateRoxyProfiles(
    client,
    workspaceId,
    extractRows<RoxyProfile>(response.data)
  );
  debugRoxyBrowser(`Found ${profiles.length} RoxyBrowser profile(s).`);

  const profile = profiles.find(isLikelyFirefoxProfile);

  if (profile) {
    debugRoxyBrowser(`Selected matching profile dirId=${profile.dirId ?? "unknown"}.`);
    return profile;
  }

  if (profiles.length === 1) {
    debugRoxyBrowser(
      `No explicit Firefox marker found; using the only profile dirId=${profiles[0]?.dirId ?? "unknown"}.`
    );
    return profiles[0]!;
  }

  if (profiles.length > 1) {
    debugRoxyBrowser(
      `No profile matched ROXYBROWSER_PROFILE_MATCH="${ROXYBROWSER_PROFILE_MATCH}". Creating a new profile.`
    );
  } else {
    debugRoxyBrowser("No profiles found. Creating a new profile.");
  }

  const createResponse = await callRoxy(
    "RoxyBrowser profile create",
    () => client.browser_create(buildRoxyFirefoxProfilePayload(workspaceId, projectId))
  );

  const dirId = readString(createResponse.data, "dirId");
  if (!dirId) {
    throw new Error("RoxyBrowser profile create response did not include data.dirId.");
  }

  debugRoxyBrowser(`Created profile dirId=${dirId}.`);

  return { dirId };
}

async function hydrateRoxyProfiles(
  client: RoxyClient,
  workspaceId: number,
  profiles: RoxyProfile[]
): Promise<RoxyProfile[]> {
  const hydrated: RoxyProfile[] = [];

  for (const profile of profiles) {
    if (!profile.dirId) {
      hydrated.push(profile);
      continue;
    }

    try {
      const detail = await callRoxy(
        "RoxyBrowser profile detail lookup",
        () => client.browser_detail(workspaceId, profile.dirId)
      );
      if (detail.code !== 0) {
        hydrated.push(profile);
        continue;
      }

      const detailRows = extractRows<RoxyProfile>(detail.data);
      hydrated.push({
        ...profile,
        ...(detailRows[0] ?? {})
      });
    } catch {
      hydrated.push(profile);
    }
  }

  return hydrated;
}

async function openRoxyBrowserBidiEndpoint(
  client: RoxyClient,
  workspaceId: number,
  dirId: string
): Promise<string> {
  debugRoxyBrowser(`Opening RoxyBrowser profile dirId=${dirId}.`);
  const openResponse = await callRoxy(
    "RoxyBrowser profile open",
    () => client.browser_open(
      dirId,
      [],
      {
        workspaceId,
        forceOpen: ROXYBROWSER_FORCE_OPEN,
        headless: false
      }
    )
  );

  const endpoint = extractConnectionEndpoint(openResponse.data, dirId);

  if (endpoint) {
    debugRoxyBrowser(`Opened profile websocket endpoint ${maskEndpoint(endpoint)}.`);
    return endpoint;
  }

  debugRoxyBrowser(`Open response had no websocket endpoint. Checking connection info for dirId=${dirId}.`);
  const connectionResponse = await callRoxy(
    "RoxyBrowser connection info lookup",
    () => client.browser_connection_info(dirId)
  );
  const existingEndpoint = extractConnectionEndpoint(connectionResponse.data, dirId);

  if (existingEndpoint) {
    debugRoxyBrowser(`Using connection info websocket endpoint ${maskEndpoint(existingEndpoint)}.`);
    return existingEndpoint;
  }

  throw new Error("RoxyBrowser profile open response did not include a websocket endpoint.");
}

function isLikelyFirefoxProfile(profile: RoxyProfile): boolean {
  const searchable = [
    profile.browserName,
    profile.browserType,
    profile.kernelType,
    profile.coreType,
    profile.windowName,
    profile.windowRemark
  ]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();

  return searchable.includes(ROXYBROWSER_PROFILE_MATCH.toLowerCase());
}

function buildRoxyFirefoxProfilePayload(
  workspaceId: number,
  projectId: number | undefined
): Record<string, unknown> {
  return {
    workspaceId,
    ...(projectId ? { projectId } : {}),
    windowName: ROXYBROWSER_PROFILE_NAME,
    windowRemark: "firefox bidi e2e",
    browserType: "firefox",
    coreType: "firefox",
    os: defaultRoxyBrowserOs(),
    searchEngine: "Google",
    proxyInfo: {
      moduleId: 0,
      proxyMethod: "custom",
      proxyCategory: "noproxy",
      ipType: "IPV4"
    },
    ...parseJsonEnv("ROXYBROWSER_CREATE_PROFILE_JSON")
  };
}

function defaultRoxyBrowserOs(): string {
  switch (process.platform) {
    case "darwin":
      return "macOS";
    case "linux":
      return "Linux";
    default:
      return "Windows";
  }
}

function extractConnectionEndpoint(data: unknown, dirId: string): string | undefined {
  const candidates = Array.isArray(data) ? data : [data];
  const connection = candidates
    .filter(isRecord)
    .find((item) => !readString(item, "dirId") || readString(item, "dirId") === dirId);

  const ws = readString(connection, "ws")
    ?? readString(connection, "webSocketUrl")
    ?? readString(connection, "wsEndpoint");

  if (ws) {
    return toBidiWsEndpoint(ws);
  }

  const http = readString(connection, "http");
  return http ? toBidiWsEndpoint(`ws://${http}`) : undefined;
}

function toBidiWsEndpoint(endpoint: string): string {
  const url = new URL(endpoint);

  if (url.pathname.startsWith("/devtools/browser/")) {
    url.pathname = "/";
    url.search = "";
    url.hash = "";
  }

  return url.toString();
}

function extractRows<T>(data: unknown): T[] {
  if (Array.isArray(data)) {
    return data as T[];
  }

  if (isRecord(data) && Array.isArray(data.rows)) {
    return data.rows as T[];
  }

  return [];
}

async function callRoxy(action: string, run: () => Promise<RoxyResponse>): Promise<RoxyResponse> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= ROXYBROWSER_API_RETRIES; attempt += 1) {
    try {
      const response = await run();

      if (response.code === 0) {
        return response;
      }

      lastError = new Error(`${action} failed: ${JSON.stringify(response)}`);

      if (!isRetryableRoxyResponse(response) || attempt === ROXYBROWSER_API_RETRIES) {
        break;
      }
    } catch (error) {
      lastError = error;

      if (attempt === ROXYBROWSER_API_RETRIES) {
        break;
      }
    }

    debugRoxyBrowser(`${action} failed; retrying (${attempt + 1}/${ROXYBROWSER_API_RETRIES}).`);
    await delay(250 * (attempt + 1));
  }

  throw lastError instanceof Error ? lastError : new Error(`${action} failed.`);
}

function isRetryableRoxyResponse(response: RoxyResponse): boolean {
  const message = String(response.msg ?? "");
  return response.code === 101 || message.includes("502") || message.includes("timeout");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseNumber(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseJsonEnv(name: string): Record<string, unknown> {
  const value = process.env[name];

  if (!value) {
    return {};
  }

  const parsed = JSON.parse(value) as unknown;
  if (!isRecord(parsed)) {
    throw new Error(`${name} must be a JSON object.`);
  }

  return parsed;
}

function readString(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const result = value[key];
  return typeof result === "string" && result ? result : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function debugRoxyBrowser(message: string): void {
  if (ROXYBROWSER_DEBUG) {
    console.log(`[roxybrowser:e2e:bidi] ${message}`);
  }
}

function maskEndpoint(endpoint: string): string {
  return endpoint.replace(/\/devtools\/browser\/.*/, "/devtools/browser/***");
}

export async function withBidiPage<T>(
  run: (page: Page, context: BrowserContext, browser: Browser) => Promise<T>
): Promise<T> {
  const browser = await openBidiBrowser();
  const keepBrowserOpen = usesExternalBidiEndpoint;

  try {
    const context = await browser.newContext(
      usesExternalBidiEndpoint
        ? {
            reuseDefaultUserContext: true
          }
        : {}
    );

    try {
      const page = await context.newPage();

      try {
        return await run(page, context, browser);
      } finally {
        await page.close();
      }
    } finally {
      await context.close();
    }
  } finally {
    if (!keepBrowserOpen) {
      await browser.close();
    }
  }
}

async function closeExternalBidiBrowser(): Promise<void> {
  const browser = externalBidiBrowser;
  externalBidiBrowser = undefined;
  externalBidiBrowserKey = undefined;

  if (!browser) {
    return;
  }

  await browser.close().catch(() => {});
  await delay(250);
}
