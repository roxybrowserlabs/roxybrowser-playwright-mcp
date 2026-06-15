import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { RoxyClient } from "../tests/helpers/roxybrowser-openai.mjs";

const envPath = resolve(process.cwd(), ".env");

if (existsSync(envPath)) {
  loadEnvFile(envPath);
}

let cachedProfileDirId;

export async function resolveRoxyBrowserFirefoxBidiEndpoint(options = {}) {
  const apiPort = options.apiPort ?? process.env.ROXYBROWSER_API_PORT ?? process.env.ROXY_API_PORT ?? "50000";
  const apiToken = options.apiToken ?? process.env.ROXYBROWSER_API_TOKEN ?? process.env.ROXY_API_TOKEN;
  const workspaceIdEnv = options.workspaceId ?? process.env.ROXYBROWSER_WORKSPACE_ID;
  const projectIdEnv = options.projectId ?? process.env.ROXYBROWSER_PROJECT_ID;
  const profileId = options.profileId ?? process.env.ROXYBROWSER_PROFILE_ID;
  const profileName = options.profileName ?? process.env.ROXYBROWSER_PROFILE_NAME ?? "RoxyBrowser Firefox BiDi E2E";
  const coreType = options.coreType ?? process.env.ROXYBROWSER_CORE_TYPE ?? "Firefox";
  const coreVersion = options.coreVersion ?? process.env.ROXYBROWSER_CORE_VERSION ?? "146";
  const windowRemark = options.windowRemark ?? process.env.ROXYBROWSER_WINDOW_REMARK ?? "firefox bidi e2e";
  const debug = Boolean(options.debug ?? process.env.ROXYBROWSER_DEBUG === "1");

  if (!apiToken) {
    throw new Error("Missing ROXYBROWSER_API_TOKEN or ROXY_API_TOKEN.");
  }

  const client = new RoxyClient(apiPort, apiToken);
  const workspaceResponse = await client.workspace_project();
  const workspaceRows = extractRows(workspaceResponse.data);
  const workspace =
    parseNumber(workspaceIdEnv)
      ? { id: parseNumber(workspaceIdEnv) }
      : workspaceRows.find((row) => row.id ?? row.workspaceId) ?? workspaceRows[0];

  if (!workspace) {
    throw new Error("No RoxyBrowser workspace found.");
  }

  const workspaceId = workspace.id ?? workspace.workspaceId;
  const projectId =
    parseNumber(projectIdEnv)
    ?? workspace.project_details?.find((project) => project.projectId)?.projectId;

  if (debug) {
    console.log("[roxybrowser-bidi] workspaceId:", workspaceId);
    console.log("[roxybrowser-bidi] projectId:", projectId ?? "<none>");
    if (profileId) {
      console.log("[roxybrowser-bidi] profileId override:", profileId);
    }
  }

  const listResponse = await client.browser_list(
    workspaceId,
    {
      ...(projectId ? { projectIds: String(projectId) } : {}),
      page_size: 100
    }
  );
  const profiles = extractRows(listResponse.data);

  let selectedProfile = cachedProfileDirId ? { dirId: cachedProfileDirId } : null;

  if (profileId) {
    selectedProfile = { dirId: profileId };
  } else if (!selectedProfile) {
    const desiredRemark = String(windowRemark).trim();
    const desiredCoreType = String(coreType).trim().toLowerCase();
    const desiredCoreVersion = String(coreVersion).trim();

    for (const profile of profiles) {
      if (!profile.dirId) {
        continue;
      }

      const detailResponse = await client.browser_detail(workspaceId, profile.dirId);
      const detail = firstRecord(detailResponse.data) ?? profile;
      const detailRemark = String(detail.windowRemark ?? "").trim();
      const detailCoreType = String(detail.coreType ?? "").trim().toLowerCase();
      const detailCoreVersion = String(detail.coreVersion ?? "").trim();

      if (
        detailRemark === desiredRemark
        && detailCoreType === desiredCoreType
        && detailCoreVersion === desiredCoreVersion
      ) {
        selectedProfile = detail;
        break;
      }
    }
  }

  if (!selectedProfile) {
    const createPayload = {
      workspaceId,
      ...(projectId ? { projectId } : {}),
      ...(profileName ? { windowName: profileName } : {}),
      windowRemark,
      coreType,
      ...(coreVersion ? { coreVersion } : {}),
      fingerInfo: {
        portScanProtect: false
      }
    };

    if (debug) {
      console.log("[roxybrowser-bidi] createPayload:", JSON.stringify(createPayload, null, 2));
    }

    const createResponse = await client.browser_create(createPayload);
    const dirId = createResponse?.data?.dirId;
    if (!dirId) {
      throw new Error("Create response did not include data.dirId.");
    }

    const detailResponse = await client.browser_detail(workspaceId, dirId);
    selectedProfile = firstRecord(detailResponse.data) ?? { dirId };

    if (debug) {
      console.log("[roxybrowser-bidi] createdProfile:", JSON.stringify(summarizeProfile(selectedProfile), null, 2));
    }
  }

  const dirId = selectedProfile.dirId;
  cachedProfileDirId = dirId;
  const openResponse = await client.browser_open(dirId, []);
  const endpoint = extractBidiCandidate(openResponse.data, dirId);

  if (endpoint) {
    return endpoint;
  }

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const connectionInfo = await client.browser_connection_info(dirId);
    const connectionEndpoint = extractBidiCandidate(connectionInfo.data, dirId);
    if (connectionEndpoint) {
      return connectionEndpoint;
    }
    await delay(250 * (attempt + 1));
  }

  throw new Error("RoxyBrowser profile open response did not include a verified Firefox BiDi endpoint.");
}

export async function closeRoxyBrowserFirefoxBidiProfile(options = {}) {
  const apiPort = options.apiPort ?? process.env.ROXYBROWSER_API_PORT ?? process.env.ROXY_API_PORT ?? "50000";
  const apiToken = options.apiToken ?? process.env.ROXYBROWSER_API_TOKEN ?? process.env.ROXY_API_TOKEN;
  const workspaceIdEnv = options.workspaceId ?? process.env.ROXYBROWSER_WORKSPACE_ID;
  const projectIdEnv = options.projectId ?? process.env.ROXYBROWSER_PROJECT_ID;
  const profileId = options.profileId ?? process.env.ROXYBROWSER_PROFILE_ID;
  const coreType = options.coreType ?? process.env.ROXYBROWSER_CORE_TYPE ?? "Firefox";
  const coreVersion = options.coreVersion ?? process.env.ROXYBROWSER_CORE_VERSION ?? "146";
  const windowRemark = options.windowRemark ?? process.env.ROXYBROWSER_WINDOW_REMARK ?? "firefox bidi e2e";

  if (!apiToken) {
    return;
  }

  const client = new RoxyClient(apiPort, apiToken);
  const dirIds = [];

  if (profileId ?? cachedProfileDirId) {
    dirIds.push(profileId ?? cachedProfileDirId);
  } else {
    const workspaceResponse = await client.workspace_project().catch(() => undefined);
    const workspaceRows = extractRows(workspaceResponse?.data);
    const workspace =
      parseNumber(workspaceIdEnv)
        ? { id: parseNumber(workspaceIdEnv) }
        : workspaceRows.find((row) => row.id ?? row.workspaceId) ?? workspaceRows[0];

    const workspaceId = workspace?.id ?? workspace?.workspaceId;
    if (workspaceId) {
      const projectId =
        parseNumber(projectIdEnv)
        ?? workspace.project_details?.find((project) => project.projectId)?.projectId;
      const listResponse = await client.browser_list(
        workspaceId,
        {
          ...(projectId ? { projectIds: String(projectId) } : {}),
          page_size: 100
        }
      ).catch(() => undefined);
      const profiles = extractRows(listResponse?.data);
      const desiredRemark = String(windowRemark).trim();
      const desiredCoreType = String(coreType).trim().toLowerCase();
      const desiredCoreVersion = String(coreVersion).trim();

      for (const profile of profiles) {
        if (!profile?.dirId) {
          continue;
        }

        const detailResponse = await client.browser_detail(workspaceId, profile.dirId).catch(() => undefined);
        const detail = firstRecord(detailResponse?.data) ?? profile;
        const detailRemark = String(detail.windowRemark ?? "").trim();
        const detailCoreType = String(detail.coreType ?? "").trim().toLowerCase();
        const detailCoreVersion = String(detail.coreVersion ?? "").trim();

        if (
          detailRemark === desiredRemark
          && detailCoreType === desiredCoreType
          && detailCoreVersion === desiredCoreVersion
        ) {
          dirIds.push(profile.dirId);
        }
      }
    }
  }

  cachedProfileDirId = undefined;

  for (const dirId of new Set(dirIds.filter(Boolean))) {
    await client.browser_close(dirId).catch(() => {});
    await waitForRoxyBrowserProfileToClose(client, dirId);
  }
}

function parseNumber(value) {
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
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

function firstRecord(data) {
  if (Array.isArray(data)) {
    return data[0];
  }

  if (data && typeof data === "object" && Array.isArray(data.rows)) {
    return data.rows[0];
  }

  if (data && typeof data === "object") {
    return data;
  }

  return undefined;
}

function summarizeProfile(profile) {
  return {
    dirId: profile.dirId,
    windowName: profile.windowName,
    windowRemark: profile.windowRemark,
    coreType: profile.coreType,
    coreVersion: profile.coreVersion,
    os: profile.os,
    osVersion: profile.osVersion,
    browserType: profile.browserType,
    kernelType: profile.kernelType,
    userAgent: profile.userAgent
  };
}

function extractBidiCandidate(data, dirId) {
  const candidates = Array.isArray(data)
    ? data
    : data && typeof data === "object" && Array.isArray(data.rows)
      ? data.rows
      : [data];

  const connection = candidates.find((item) => {
    if (!item || typeof item !== "object") {
      return false;
    }

    const candidateDirId = typeof item.dirId === "string" ? item.dirId : undefined;
    return !candidateDirId || candidateDirId === dirId;
  });

  if (!connection || typeof connection !== "object") {
    return undefined;
  }

  const ws = connection.ws ?? connection.webSocketUrl ?? connection.wsEndpoint;
  if (typeof ws === "string") {
    return ws.includes("/devtools/browser/") ? undefined : toBidiWsEndpoint(ws);
  }

  const http = connection.http;
  if (typeof http === "string") {
    return toBidiWsEndpoint(/^wss?:\/\//.test(http) ? http : `ws://${http}`);
  }

  return undefined;
}

function toBidiWsEndpoint(endpoint) {
  const url = new URL(endpoint);

  if (url.pathname.startsWith("/devtools/browser/")) {
    url.pathname = "/";
    url.search = "";
    url.hash = "";
  }

  return url.toString();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForRoxyBrowserProfileToClose(client, dirId) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const response = await client.browser_connection_info(dirId).catch(() => undefined);
    const candidates = Array.isArray(response?.data)
      ? response.data
      : response?.data && typeof response.data === "object" && Array.isArray(response.data.rows)
        ? response.data.rows
        : response?.data
          ? [response.data]
          : [];

    const stillOpen = candidates.some((item) => {
      if (!item || typeof item !== "object") {
        return false;
      }

      if (typeof item.dirId === "string" && item.dirId !== dirId) {
        return false;
      }

      return Boolean(item.ws || item.webSocketUrl || item.wsEndpoint || item.http);
    });

    if (!stillOpen) {
      return;
    }

    await delay(250 * (attempt + 1));
  }
}
