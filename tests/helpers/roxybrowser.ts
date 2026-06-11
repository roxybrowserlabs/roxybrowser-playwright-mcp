export interface RoxyBrowserEndpointOptions {
  protocol: "bidi" | "cdp";
  apiPort: string;
  apiToken: string;
  workspaceId?: string | undefined;
  projectId?: string | undefined;
  profileId?: string | undefined;
  profileName: string;
  profileMatch: string;
  browserType?: string | undefined;
  coreType?: string | undefined;
  windowRemark: string;
  createProfileJsonEnv?: string | undefined;
  debug?: boolean | undefined;
  debugScope: string;
  retries?: number | undefined;
  forceOpen?: boolean | undefined;
  headless?: boolean | undefined;
  openOptions?: Record<string, unknown> | undefined;
  useSingleProfileFallback?: boolean | undefined;
  createMissingProfile?: boolean | undefined;
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

export async function resolveRoxyBrowserEndpoint(
  options: RoxyBrowserEndpointOptions
): Promise<string> {
  const { RoxyClient } = await import("./roxybrowser-openai.mjs");
  const client = new RoxyClient(options.apiPort, options.apiToken) as RoxyClient;
  debugRoxyBrowser(options, `Using RoxyBrowser API on 127.0.0.1:${options.apiPort}.`);
  await callRoxy(options, "RoxyBrowser API health check", () => client.health());

  const workspace = await resolveRoxyWorkspace(client, options);
  const workspaceId = workspace.id ?? workspace.workspaceId;

  if (!workspaceId) {
    throw new Error("Unable to resolve a RoxyBrowser workspaceId.");
  }

  debugRoxyBrowser(options, `Resolved workspaceId=${workspaceId}.`);

  const projectId = parseNumber(options.projectId)
    ?? workspace.project_details?.find((project) => project.projectId)?.projectId;
  debugRoxyBrowser(options, `Resolved projectId=${projectId ?? "none"}.`);

  const profileOrEndpoint = await resolveRoxyProfileOrEndpoint(client, workspaceId, projectId, options);
  if (typeof profileOrEndpoint === "string") {
    return profileOrEndpoint;
  }

  const dirId = profileOrEndpoint.dirId;

  if (!dirId) {
    throw new Error("Unable to resolve a RoxyBrowser profile dirId.");
  }

  return await openRoxyBrowserEndpoint(client, dirId, options);
}

async function resolveRoxyWorkspace(
  client: RoxyClient,
  options: RoxyBrowserEndpointOptions
): Promise<RoxyWorkspace> {
  const workspaceId = parseNumber(options.workspaceId);

  if (workspaceId) {
    return { id: workspaceId };
  }

  const response = await callRoxy(options, "RoxyBrowser workspace lookup", () => client.workspace_project());
  const rows = extractRows<RoxyWorkspace>(response.data);
  const workspace = rows.find((row) => row.id ?? row.workspaceId) ?? rows[0];

  if (!workspace) {
    throw new Error("RoxyBrowser API returned no workspaces.");
  }

  return workspace;
}

async function resolveRoxyProfileOrEndpoint(
  client: RoxyClient,
  workspaceId: number,
  projectId: number | undefined,
  options: RoxyBrowserEndpointOptions
): Promise<RoxyProfile | string> {
  if (options.profileId) {
    return { dirId: options.profileId };
  }

  const response = await callRoxy(
    options,
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
    extractRows<RoxyProfile>(response.data),
    options
  );
  debugRoxyBrowser(options, `Found ${profiles.length} RoxyBrowser profile(s).`);

  const profile = profiles.find((candidate) => isLikelyProfile(candidate, options));

  if (profile) {
    debugRoxyBrowser(options, `Selected matching profile dirId=${profile.dirId ?? "unknown"}.`);
    return profile;
  }

  if (options.protocol === "cdp" && profiles.length > 0) {
    const endpoint = await firstWorkingCdpEndpoint(client, workspaceId, profiles, options);
    if (endpoint) {
      return endpoint;
    }
  }

  if (options.useSingleProfileFallback !== false && profiles.length === 1) {
    debugRoxyBrowser(
      options,
      `No explicit profile marker found; using the only profile dirId=${profiles[0]?.dirId ?? "unknown"}.`
    );
    return profiles[0]!;
  }

  if (profiles.length > 1) {
    debugRoxyBrowser(
      options,
      `No profile matched profileMatch="${options.profileMatch}". Creating a new profile.`
    );
  } else {
    debugRoxyBrowser(options, "No profiles found. Creating a new profile.");
  }

  if (options.createMissingProfile === false) {
    throw new Error(
      `No RoxyBrowser profile exposed a CDP endpoint. Create or keep open a Chrome-kernel RoxyBrowser profile before running this suite.`
    );
  }

  const createResponse = await callRoxy(
    options,
    "RoxyBrowser profile create",
    () => client.browser_create(buildRoxyProfilePayload(workspaceId, projectId, options))
  );

  const dirId = readString(createResponse.data, "dirId");
  if (!dirId) {
    throw new Error("RoxyBrowser profile create response did not include data.dirId.");
  }

  debugRoxyBrowser(options, `Created profile dirId=${dirId}.`);

  return { dirId };
}

async function firstWorkingCdpEndpoint(
  client: RoxyClient,
  workspaceId: number,
  profiles: RoxyProfile[],
  options: RoxyBrowserEndpointOptions
): Promise<string | undefined> {
  for (const profile of profiles) {
    if (!profile.dirId) {
      continue;
    }

    let endpoint: string;
    try {
      endpoint = await openRoxyBrowserEndpoint(client, profile.dirId, options);
    } catch {
      continue;
    }

    if (await isCdpEndpoint(endpoint)) {
      debugRoxyBrowser(options, `Selected CDP-capable profile dirId=${profile.dirId}.`);
      return endpoint;
    }

    debugRoxyBrowser(options, `Profile dirId=${profile.dirId} did not expose a CDP endpoint.`);
  }

  return undefined;
}

async function hydrateRoxyProfiles(
  client: RoxyClient,
  workspaceId: number,
  profiles: RoxyProfile[],
  options: RoxyBrowserEndpointOptions
): Promise<RoxyProfile[]> {
  const hydrated: RoxyProfile[] = [];

  for (const profile of profiles) {
    if (!profile.dirId) {
      hydrated.push(profile);
      continue;
    }

    try {
      const detail = await callRoxy(
        options,
        "RoxyBrowser profile detail lookup",
        () => client.browser_detail(workspaceId, profile.dirId!)
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

async function openRoxyBrowserEndpoint(
  client: RoxyClient,
  dirId: string,
  options: RoxyBrowserEndpointOptions
): Promise<string> {
  debugRoxyBrowser(options, `Opening RoxyBrowser profile dirId=${dirId}.`);
  const openResponse = await callRoxy(
    options,
    "RoxyBrowser profile open",
    () => client.browser_open(
      dirId,
      [],
      options.openOptions
    )
  );

  const endpoint = await extractConnectionEndpoint(openResponse.data, dirId, options);

  if (endpoint) {
    debugRoxyBrowser(options, `Opened profile endpoint ${maskEndpoint(endpoint)}.`);
    return endpoint;
  }

  debugRoxyBrowser(options, `Open response had no endpoint. Checking connection info for dirId=${dirId}.`);
  const connectionResponse = await callRoxy(
    options,
    "RoxyBrowser connection info lookup",
    () => client.browser_connection_info(dirId)
  );
  const existingEndpoint = await extractConnectionEndpoint(connectionResponse.data, dirId, options);

  if (existingEndpoint) {
    debugRoxyBrowser(options, `Using connection info endpoint ${maskEndpoint(existingEndpoint)}.`);
    return existingEndpoint;
  }

  throw new Error("RoxyBrowser profile open response did not include a verified CDP endpoint.");
}

function isLikelyProfile(profile: RoxyProfile, options: RoxyBrowserEndpointOptions): boolean {
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

  return searchable.includes(options.profileMatch.toLowerCase());
}

function buildRoxyProfilePayload(
  workspaceId: number,
  projectId: number | undefined,
  options: RoxyBrowserEndpointOptions
): Record<string, unknown> {
  return {
    workspaceId,
    ...(projectId ? { projectId } : {}),
    windowName: options.profileName,
    windowRemark: options.windowRemark,
    os: defaultRoxyBrowserOs(),
    searchEngine: "Google",
    proxyInfo: {
      moduleId: 0,
      proxyMethod: "custom",
      proxyCategory: "noproxy",
      ipType: "IPV4"
    },
    ...(options.browserType ? { browserType: options.browserType } : {}),
    ...(options.coreType ? { coreType: options.coreType } : {}),
    ...parseJsonEnv(options.createProfileJsonEnv)
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

async function extractConnectionEndpoint(
  data: unknown,
  dirId: string,
  options: RoxyBrowserEndpointOptions
): Promise<string | undefined> {
  const candidates = Array.isArray(data) ? data : [data];
  const connection = candidates
    .filter(isRecord)
    .find((item) => !readString(item, "dirId") || readString(item, "dirId") === dirId);

  const http = readString(connection, "http");
  if (options.protocol === "cdp") {
    const cdpWs = [
      readString(connection, "cdpWs"),
      readString(connection, "cdpWsEndpoint"),
      readString(connection, "devtoolsWs"),
      readString(connection, "devtoolsWebSocketUrl"),
      readString(connection, "webSocketDebuggerUrl"),
      readString(connection, "ws"),
      readString(connection, "webSocketUrl"),
      readString(connection, "wsEndpoint")
    ].find((value) => value?.includes("/devtools/browser/"));

    if (cdpWs) {
      return cdpWs;
    }

    if (!http) {
      return undefined;
    }

    const httpEndpoint = /^https?:\/\//.test(http) ? http : `http://${http}`;
    return (await isCdpEndpoint(httpEndpoint)) ? httpEndpoint : undefined;
  }

  const ws = readString(connection, "ws")
    ?? readString(connection, "webSocketUrl")
    ?? readString(connection, "wsEndpoint");

  if (ws) {
    return toBidiWsEndpoint(ws);
  }

  if (!http) {
    return undefined;
  }

  return toBidiWsEndpoint(/^wss?:\/\//.test(http) ? http : `ws://${http}`);
}

async function isCdpEndpoint(endpoint: string): Promise<boolean> {
  const url = new URL(endpoint);
  if (url.protocol === "ws:" || url.protocol === "wss:") {
    return url.pathname.startsWith("/devtools/browser/");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return false;
  }

  try {
    const versionUrl = new URL("/json/version", url);
    const response = await fetch(versionUrl);
    if (!response.ok) {
      return false;
    }
    const payload = await response.json() as { webSocketDebuggerUrl?: unknown };
    return typeof payload.webSocketDebuggerUrl === "string";
  } catch {
    return false;
  }
}

export function toBidiWsEndpoint(endpoint: string): string {
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

async function callRoxy(
  options: RoxyBrowserEndpointOptions,
  action: string,
  run: () => Promise<RoxyResponse>
): Promise<RoxyResponse> {
  let lastError: unknown;
  const retries = options.retries ?? 2;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await run();

      if (response.code === 0) {
        return response;
      }

      lastError = new Error(`${action} failed: ${JSON.stringify(response)}`);

      if (!isRetryableRoxyResponse(response) || attempt === retries) {
        break;
      }
    } catch (error) {
      lastError = error;

      if (attempt === retries) {
        break;
      }
    }

    debugRoxyBrowser(options, `${action} failed; retrying (${attempt + 1}/${retries}).`);
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

export function parseNumber(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseJsonEnv(name: string | undefined): Record<string, unknown> {
  if (!name) {
    return {};
  }

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

function debugRoxyBrowser(options: RoxyBrowserEndpointOptions, message: string): void {
  if (options.debug) {
    console.log(`[${options.debugScope}] ${message}`);
  }
}

function maskEndpoint(endpoint: string): string {
  return endpoint.replace(/\/devtools\/browser\/.*/, "/devtools/browser/***");
}
