import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createRoxyBrowserMcpServer } from "../server.js";
import type {
  RoxyBrowserMcpHttpBundle,
  RoxyBrowserMcpServerBundle,
  StartRoxyBrowserMcpHttpOptions
} from "../types.js";

interface HttpSessionRecord {
  bundle: RoxyBrowserMcpServerBundle;
  transport: StreamableHTTPServerTransport;
  heartbeatActive?: boolean;
}

const DEFAULT_PING_TIMEOUT_MS = 5000;
const HEARTBEAT_INTERVAL_MS = 3000;

function pingTimeoutMs(): number {
  const value = process.env.PLAYWRIGHT_MCP_PING_TIMEOUT_MS;
  if (value === undefined) {
    return DEFAULT_PING_TIMEOUT_MS;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : DEFAULT_PING_TIMEOUT_MS;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return undefined;
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJsonRpcError(res: ServerResponse, statusCode: number, message: string): void {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json");
  res.end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message
      },
      id: null
    })
  );
}

export async function startRoxyBrowserMcpHttp(
  options: StartRoxyBrowserMcpHttpOptions
): Promise<RoxyBrowserMcpHttpBundle> {
  const host = options.host ?? "127.0.0.1";
  const path = options.path ?? "/mcp";
  const prototypeBundle = createRoxyBrowserMcpServer(options);
  const sessions = new Map<string, HttpSessionRecord>();
  let defaultAllowedHosts: string[] = [];

  const closeSession = async (sessionId: string): Promise<void> => {
    const record = sessions.get(sessionId);
    if (!record) {
      return;
    }

    record.heartbeatActive = false;
    sessions.delete(sessionId);
    await record.bundle.close();
    await record.transport.close();
  };

  const startHeartbeat = (sessionId: string): void => {
    const timeoutMs = pingTimeoutMs();
    if (timeoutMs <= 0) {
      return;
    }

    const record = sessions.get(sessionId);
    if (!record) {
      return;
    }
    record.heartbeatActive = true;

    const beat = (): void => {
      const current = sessions.get(sessionId);
      if (!current?.heartbeatActive) {
        return;
      }

      Promise.race([
        current.bundle.server.server.ping(),
        new Promise<never>((_, reject) => {
          const timer = setTimeout(() => reject(new Error("ping timeout")), timeoutMs);
          timer.unref?.();
        })
      ]).then(() => {
        const timer = setTimeout(beat, HEARTBEAT_INTERVAL_MS);
        timer.unref?.();
      }).catch(() => {
        void closeSession(sessionId);
      });
    };

    beat();
  };

  const handleMcpRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const sessionHeader = req.headers["mcp-session-id"];
    const sessionId = Array.isArray(sessionHeader) ? sessionHeader[0] : sessionHeader;
    const parsedBody =
      req.method === "POST" || req.method === "DELETE" ? await readJsonBody(req) : undefined;

    let record = sessionId ? sessions.get(sessionId) : undefined;
    if (!record) {
      if (req.method === "POST" && !sessionId && isInitializeRequest(parsedBody)) {
        const bundle = createRoxyBrowserMcpServer(options);
        let createdTransport: StreamableHTTPServerTransport | undefined;
        createdTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (createdSessionId) => {
            if (createdTransport) {
              sessions.set(createdSessionId, {
                bundle,
                transport: createdTransport
              });
              startHeartbeat(createdSessionId);
            }
          }
        });
        createdTransport.onclose = () => {
          const createdSessionId = createdTransport?.sessionId;
          if (createdSessionId) {
            void closeSession(createdSessionId);
          }
        };

        await bundle.server.connect(
          createdTransport as Parameters<typeof bundle.server.connect>[0]
        );
        await createdTransport.handleRequest(req, res, parsedBody);
        return;
      }

      sendJsonRpcError(res, 400, "Bad Request: No valid MCP session is active for this request.");
      return;
    }

    await record.transport.handleRequest(req, res, parsedBody);
  };

  const httpServer = createServer(async (req, res) => {
    try {
      if (!req.url) {
        res.statusCode = 404;
        res.end("Not Found");
        return;
      }

      const requestUrl = new URL(req.url, `http://${req.headers.host ?? host}`);
      const hostCheck = allowedHostCheck(req.headers.host, options.allowedHosts ?? defaultAllowedHosts);
      if (!hostCheck.ok) {
        if (hostCheck.reason === "missing") {
          res.statusCode = 400;
          res.end("Missing host");
          return;
        }
        res.statusCode = 403;
        res.end(`Access is only allowed at ${hostCheck.allowedHosts.join(", ")}`);
        return;
      }
      if (requestUrl.pathname === "/health" && req.method === "GET") {
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (requestUrl.pathname !== path) {
        res.statusCode = 404;
        res.end("Not Found");
        return;
      }

      if (req.method === "GET" || req.method === "POST" || req.method === "DELETE") {
        await handleMcpRequest(req, res);
        return;
      }

      res.statusCode = 405;
      res.end("Method Not Allowed");
    } catch (error) {
      if (!res.headersSent) {
        sendJsonRpcError(
          res,
          500,
          error instanceof Error ? error.message : "Internal server error"
        );
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(options.port, host, () => {
      httpServer.removeListener("error", reject);
      const address = httpServer.address();
      if (address && typeof address !== "string") {
        defaultAllowedHosts = [`${host}:${address.port}`.toLowerCase()];
      }
      resolve();
    });
  });

  return {
    server: prototypeBundle.server,
    httpServer,
    close: async () => {
      await Promise.all(Array.from(sessions.keys()).map(async (sessionId) => closeSession(sessionId)));
      await prototypeBundle.close();
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  };
}

function allowedHostCheck(
  headerHost: string | string[] | undefined,
  allowedHosts: string[]
): { ok: true } | { ok: false; reason: "missing" | "denied"; allowedHosts: string[] } {
  const normalizedAllowedHosts = allowedHosts.map((value) => value.toLowerCase());
  if (normalizedAllowedHosts.includes("*")) {
    return { ok: true };
  }
  const actualHost = Array.isArray(headerHost) ? headerHost[0] : headerHost;
  if (!actualHost) {
    return { ok: false, reason: "missing", allowedHosts: normalizedAllowedHosts };
  }
  return normalizedAllowedHosts.includes(actualHost.toLowerCase())
    ? { ok: true }
    : { ok: false, reason: "denied", allowedHosts: normalizedAllowedHosts };
}
