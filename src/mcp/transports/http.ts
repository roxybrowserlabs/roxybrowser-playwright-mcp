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

  const closeSession = async (sessionId: string): Promise<void> => {
    const record = sessions.get(sessionId);
    if (!record) {
      return;
    }

    sessions.delete(sessionId);
    await record.bundle.close();
    await record.transport.close();
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
