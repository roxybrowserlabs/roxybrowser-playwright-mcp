import { z } from "zod";
import { formatConnectResult } from "../format.js";
import type {
  RoxyBrowserLaunchApiResponse,
  RoxyBrowserLaunchClient,
  RoxyBrowserLaunchClientOptions,
  RoxyBrowserLaunchConfig,
  RoxyBrowserLaunchOpenArgs
} from "../types.js";
import { defineTool } from "./tool.js";

type BrowserParam = "chrome" | "firefox";
type LaunchEndpoint = {
  endpoint: string;
  sessionId?: string;
};

const connect = defineTool({
  capability: "config",
  schema: {
    name: "roxy_browser_connect",
    title: "Roxy Browser Connect",
    description: "Attach to an existing browser and seed the active tab snapshot.",
    inputSchema: z.object({
      endpoint: z.string().min(1),
      browser: z.enum(["chrome", "firefox"]).default("chrome"),
      sessionId: z.string().min(1).optional()
    }),
    type: "action"
  },
  handle: async (context, params, response) => {
    const protocol = params.browser === "firefox" ? "bidi" : "cdp";
    const result = await context.runtime.connect({
      protocol,
      endpoint: params.endpoint,
      browser: params.browser === "chrome" ? "chromium" : params.browser,
      ...(params.sessionId ? { sessionId: params.sessionId } : {})
    });
    await context.runtime.ensureActiveCursorVisualization().catch(() => undefined);
    response.addTextResult(
      formatConnectResult({
        ...result,
        browserName: result.browserName === "chromium" ? "chrome" : result.browserName
      })
    );
  }
});

const launchInputSchema = z.object({
  dirId: z.string().min(1),
  browser: z.enum(["chrome", "firefox"]).default("chrome"),
  forceOpen: z.boolean().default(true),
  args: z.array(z.string()).optional()
});

export function createRoxyBrowserLaunchTool(config: RoxyBrowserLaunchConfig) {
  const { workspaceId, client: launchClient } = resolveRoxyBrowserLaunchConfig(config);

  return defineTool({
    capability: "config",
    schema: {
      name: "roxy_browser_launch",
      title: "Roxy Browser Launch",
      description: "Open a RoxyBrowser profile if needed, attach to it, and seed the active tab snapshot.",
      inputSchema: launchInputSchema,
      type: "action"
    },
    handle: async (context, params, response) => {
      const protocol = params.browser === "firefox" ? "bidi" : "cdp";
      const browserName = params.browser === "chrome" ? "chromium" : params.browser;
      let launchEndpoint = extractConnectionEndpoint(
        requireSuccessfulApiResponse(
          "RoxyBrowser connection info lookup",
          await launchClient.getConnectionInfo([params.dirId])
        ).data,
        params.dirId,
        params.browser
      );

      if (!launchEndpoint) {
        const openArgs: RoxyBrowserLaunchOpenArgs = {
          workspaceId,
          dirId: params.dirId,
          forceOpen: params.forceOpen,
          ...(params.args !== undefined ? { args: params.args } : {})
        };
        const openResponse = requireSuccessfulApiResponse(
          "RoxyBrowser profile open",
          await launchClient.openBrowser(openArgs)
        );
        launchEndpoint = extractConnectionEndpoint(openResponse.data, params.dirId, params.browser);

        if (!launchEndpoint) {
          launchEndpoint = extractConnectionEndpoint(
            requireSuccessfulApiResponse(
              "RoxyBrowser connection info lookup",
              await launchClient.getConnectionInfo([params.dirId])
            ).data,
            params.dirId,
            params.browser
          );
        }
      }

      if (!launchEndpoint) {
        throw new Error(
          params.browser === "firefox"
            ? `RoxyBrowser profile ${params.dirId} did not expose a Firefox BiDi endpoint.`
            : `RoxyBrowser profile ${params.dirId} did not expose a Chrome CDP endpoint.`
        );
      }

      const result = await context.runtime.connect({
        protocol,
        endpoint: launchEndpoint.endpoint,
        browser: browserName,
        ...(launchEndpoint.sessionId
          ? { sessionId: launchEndpoint.sessionId }
          : {})
      });
      await context.runtime.ensureActiveCursorVisualization().catch(() => undefined);
      const payload = {
        browsers: [
          {
            dirId: params.dirId,
            endpoint: launchEndpoint.endpoint,
            connected: true,
            pageUrl: result.tabs.find((tab) => tab.active)?.url ?? "",
            browserType: params.browser
          }
        ]
      };
      response.setRawResults();
      response.addStructuredResult(payload);
      response.addTextResult(JSON.stringify(payload, null, 2));
    }
  });
}

function resolveRoxyBrowserLaunchConfig(
  config: RoxyBrowserLaunchConfig
): { workspaceId: number; client: RoxyBrowserLaunchClient } {
  if ("client" in config) {
    return {
      workspaceId: config.workspaceId,
      client: config.client
    };
  }
  return {
    workspaceId: config.workspaceId,
    client: new HttpRoxyBrowserLaunchClient(config)
  };
}

class HttpRoxyBrowserLaunchClient implements RoxyBrowserLaunchClient {
  private readonly baseUrl: string;

  constructor(private readonly options: RoxyBrowserLaunchClientOptions) {
    const host = options.host ?? "127.0.0.1";
    const apiPort = options.apiPort ?? "50000";
    this.baseUrl = `http://${host}:${apiPort}`;
  }

  async getConnectionInfo(dirIds?: string[]): Promise<RoxyBrowserLaunchApiResponse> {
    const url = new URL("/browser/connection_info", this.baseUrl);
    if (dirIds && dirIds.length > 0) {
      url.searchParams.set("dirIds", dirIds.join(","));
    }
    return await this.request(url, { method: "GET" });
  }

  async openBrowser(args: RoxyBrowserLaunchOpenArgs): Promise<RoxyBrowserLaunchApiResponse> {
    return await this.request(new URL("/browser/open", this.baseUrl), {
      method: "POST",
      body: JSON.stringify(args)
    });
  }

  private async request(
    url: URL,
    init: RequestInit
  ): Promise<RoxyBrowserLaunchApiResponse> {
    const fetchResponse = await fetch(url, {
      ...init,
      headers: {
        "content-type": "application/json",
        token: this.options.apiToken
      }
    });
    if (!fetchResponse.ok) {
      throw new Error(
        `RoxyBrowser API request failed: ${fetchResponse.status} ${fetchResponse.statusText}`
      );
    }
    return await fetchResponse.json() as RoxyBrowserLaunchApiResponse;
  }
}

function requireSuccessfulApiResponse(
  action: string,
  response: RoxyBrowserLaunchApiResponse
): RoxyBrowserLaunchApiResponse {
  if (response.code !== undefined && response.code !== 0) {
    throw new Error(`${action} failed: ${response.msg ?? JSON.stringify(response)}`);
  }
  return response;
}

function extractConnectionEndpoint(
  data: unknown,
  dirId: string,
  browser: BrowserParam
): LaunchEndpoint | undefined {
  const candidates = extractRecords(data);
  const connection = candidates.find((item) => {
    const itemDirId = readString(item, "dirId");
    return itemDirId === undefined || itemDirId === dirId;
  });

  if (!connection) {
    return undefined;
  }

  const endpoint = browser === "firefox"
    ? extractBidiEndpoint(connection)
    : extractCdpEndpoint(connection);
  if (!endpoint) {
    return undefined;
  }

  const sessionId = extractSessionId(data, endpoint);
  return {
    endpoint,
    ...(sessionId !== undefined ? { sessionId } : {})
  };
}

function extractCdpEndpoint(connection: Record<string, unknown>): string | undefined {
  const ws = [
    "cdpWs",
    "cdpWsEndpoint",
    "devtoolsWs",
    "devtoolsWebSocketUrl",
    "webSocketDebuggerUrl",
    "ws",
    "webSocketUrl",
    "wsEndpoint"
  ]
    .map((key) => readString(connection, key))
    .find((value) => value?.includes("/devtools/browser/"));

  if (ws) {
    return ws;
  }

  const http = readString(connection, "http");
  if (!http) {
    return undefined;
  }
  return /^https?:\/\//.test(http) ? http : `http://${http}`;
}

function extractBidiEndpoint(connection: Record<string, unknown>): string | undefined {
  const ws = readString(connection, "ws")
    ?? readString(connection, "webSocketUrl")
    ?? readString(connection, "wsEndpoint");
  if (ws) {
    if (ws.includes("/devtools/browser/")) {
      return undefined;
    }
    return toBidiWsEndpoint(ws);
  }

  const http = readString(connection, "http");
  if (!http) {
    return undefined;
  }
  return toBidiWsEndpoint(toWsEndpoint(http));
}

function toWsEndpoint(endpoint: string): string {
  if (endpoint.startsWith("ws://") || endpoint.startsWith("wss://")) {
    return endpoint;
  }
  if (endpoint.startsWith("http://")) {
    return `ws://${endpoint.slice("http://".length)}`;
  }
  if (endpoint.startsWith("https://")) {
    return `wss://${endpoint.slice("https://".length)}`;
  }
  return `ws://${endpoint}`;
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

function extractSessionId(data: unknown, endpoint: string): string | undefined {
  const explicit = firstStringByKeys(data, ["sessionId", "bidiSessionId"]);
  if (explicit) {
    return explicit;
  }

  for (const candidate of extractRecords(data)) {
    const candidateSessionId = firstStringByKeys(candidate, ["sessionId", "bidiSessionId"]);
    if (candidateSessionId) {
      return candidateSessionId;
    }

    const candidateEndpoint = firstStringByKeys(candidate, ["ws", "webSocketUrl", "wsEndpoint"]);
    const parsedSessionId = parseSessionIdFromEndpoint(candidateEndpoint);
    if (parsedSessionId) {
      return parsedSessionId;
    }
  }

  return parseSessionIdFromEndpoint(endpoint);
}

function parseSessionIdFromEndpoint(endpoint: string | undefined): string | undefined {
  if (!endpoint) {
    return undefined;
  }

  try {
    const match = new URL(endpoint).pathname.match(/^\/session\/([^/]+)$/);
    return match?.[1];
  } catch {
    return undefined;
  }
}

function firstStringByKeys(value: unknown, keys: string[]): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  for (const key of keys) {
    const candidate = readString(value, key);
    if (candidate) {
      return candidate;
    }
  }

  return undefined;
}

function extractRecords(data: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(data)) {
    return data.filter(isRecord);
  }
  if (isRecord(data) && Array.isArray(data.rows)) {
    return data.rows.filter(isRecord);
  }
  return isRecord(data) ? [data] : [];
}

function readString(value: Record<string, unknown> | undefined, key: string): string | undefined {
  const candidate = value?.[key];
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export default [connect];
