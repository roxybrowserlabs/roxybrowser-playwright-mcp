import crypto from 'node:crypto';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage, MessageExtraInfo, Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolResult } from '../backend/types.js';

type Backend = {
  initialize?(clientInfo: { cwd: string; clientName: string }): Promise<void> | void;
  listTools(): Promise<Tool[]>;
  callTool(name: string, rawArguments?: unknown, progress?: unknown): Promise<ToolResult>;
  serverClosed?(): Promise<void> | void;
  dispose?(): Promise<void> | void;
};

type CreateServerOptions = {
  name: string;
  version: string;
  createBackend: (clientInfo: { cwd: string; clientName: string }) => Promise<Backend> | Backend;
  runHeartbeat?: boolean;
};

type HttpSessionEntry<TTransport extends Transport> = {
  server: Server;
  transport: TTransport;
};

type StartHttpTransportOptions = {
  host?: string;
  port?: number;
  allowedHosts?: string[];
  mcpPath?: string;
  ssePath?: string;
};

export function createMcpServer({ name, version, createBackend, runHeartbeat = false }: CreateServerOptions): Server {
  const server = new Server({ name, version }, {
    capabilities: {
      tools: {},
    },
  });

  let backendPromise: Promise<Backend> | undefined;

  const getBackend = async () => {
    if (!backendPromise) {
      backendPromise = initializeBackend(server, name, createBackend, runHeartbeat).catch(error => {
        backendPromise = undefined;
        throw error;
      });
    }
    return await backendPromise;
  };

  const resetBackend = async () => {
    if (!backendPromise)
      return;
    const backend = await backendPromise.catch(() => undefined);
    backendPromise = undefined;
    if (backend)
      await closeBackend(backend);
  };

  addServerListener(server, 'close', () => {
    void resetBackend();
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const backend = await getBackend();
    return { tools: await backend.listTools() };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    try {
      const backend = await getBackend();
      const result = await backend.callTool(request.params.name, request.params.arguments || {}, extra?.signal);
      if (result?.isClose) {
        delete result.isClose;
        await resetBackend();
      }
      return mergeTextParts(result);
    } catch (error) {
      return {
        content: [{ type: 'text', text: `### Error\n${String(error)}` }],
        isError: true,
      };
    }
  });

  return server;
}

export async function connectStdio(createServer: () => Server): Promise<{ server: Server; transport: StdioServerTransport }> {
  const server = createServer();
  const transport = new StdioServerTransport();
  process.stdin.on('end', () => void transport.close());
  await server.connect(transport);
  return { server, transport };
}

export async function startHttpTransport(
  createServer: () => Server,
  options: StartHttpTransportOptions = {}
): Promise<{
  url: string;
  baseUrl: string;
  mcpPath: string;
  ssePath: string;
  httpServer: http.Server;
  close: () => Promise<void>;
}> {
  const {
    host = 'localhost',
    port = 0,
    allowedHosts,
    mcpPath = '/mcp',
    ssePath = '/sse',
  } = options;

  const httpServer = http.createServer();
  const sseSessions = new Map<string, HttpSessionEntry<SSEServerTransport>>();
  const streamableSessions = new Map<string, HttpSessionEntry<StreamableHTTPServerTransport>>();

  httpServer.on('request', async (req, res) => {
    try {
      if (!isAllowedHost(req, allowedHosts, httpServer.address())) {
        res.statusCode = 403;
        res.end('Forbidden host');
        return;
      }

      const url = new URL(req.url || '/', 'http://localhost');
      if (url.pathname === ssePath) {
        await handleSseRequest(createServer, sseSessions, ssePath, req, res, url);
        return;
      }
      if (url.pathname === mcpPath) {
        await handleStreamableRequest(createServer, streamableSessions, req, res);
        return;
      }

      res.statusCode = 404;
      res.end('Not found');
    } catch (error) {
      res.statusCode = 500;
      res.end(String(error));
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, () => resolve());
  });

  const baseUrl = addressToUrl(httpServer.address());
  const close = async () => {
    await Promise.all([
      ...Array.from(sseSessions.values(), async (entry) => {
        sseSessions.delete(entry.transport.sessionId);
        await closeTransportServer(entry.server, entry.transport);
      }),
      ...Array.from(streamableSessions.values(), async (entry) => {
        if (entry.transport.sessionId)
          streamableSessions.delete(entry.transport.sessionId);
        await closeTransportServer(entry.server, entry.transport);
      }),
    ]);
    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) => error ? reject(error) : resolve());
    });
  };

  return {
    url: `${baseUrl}${mcpPath}`,
    baseUrl,
    mcpPath,
    ssePath,
    httpServer,
    close,
  };
}

export class MemoryTransport {
  _peer: MemoryTransport | undefined;
  _started: boolean;
  _closed: boolean;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void;

  constructor() {
    this._peer = undefined;
    this._started = false;
    this._closed = false;
    this.onclose = undefined;
    this.onerror = undefined;
    this.onmessage = undefined;
  }

  _attachPeer(peer: MemoryTransport): void {
    this._peer = peer;
  }

  async start() {
    if (this._started)
      return;
    this._started = true;
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this._closed)
      throw new Error('Memory transport is closed');
    const peer = this._peer;
    if (!peer || peer._closed)
      throw new Error('Memory transport peer is not connected');
    queueMicrotask(() => {
      peer.onmessage?.(cloneMessage(message));
    });
  }

  async close() {
    if (this._closed)
      return;
    this._closed = true;
    const peer = this._peer;
    this.onclose?.();
    if (peer && !peer._closed) {
      peer._closed = true;
      peer.onclose?.();
    }
  }
}

export function createMemoryTransportPair() {
  const client = new MemoryTransport();
  const server = new MemoryTransport();
  client._attachPeer(server);
  server._attachPeer(client);
  return { client, server };
}

export function firstRootPath(roots: Array<{ uri: string }> | undefined): string {
  const paths: string[] = [];
  for (const root of roots || []) {
    try {
      paths.push(fileURLToPath(root.uri));
    } catch {
    }
  }
  return paths[0] || process.cwd();
}

async function initializeBackend(
  server: Server,
  defaultClientName: string,
  createBackend: CreateServerOptions['createBackend'],
  runHeartbeat: boolean
): Promise<Backend> {
  const capabilities = server.getClientCapabilities();
  const roots = capabilities?.roots ? (await server.listRoots().catch(() => ({ roots: [] }))).roots : [];
  const clientInfo = {
    cwd: firstRootPath(roots),
    clientName: server.getClientVersion()?.name || defaultClientName,
  };
  const backend = await createBackend(clientInfo);
  await backend.initialize?.(clientInfo);
  if (runHeartbeat)
    startHeartbeat(server);
  return backend;
}

async function closeBackend(backend: Backend): Promise<void> {
  try {
    await backend.serverClosed?.();
  } catch {
  }
  try {
    await backend.dispose?.();
  } catch {
  }
}

function mergeTextParts(result: ToolResult): ToolResult {
  const content: ToolResult['content'] = [];
  const textParts: string[] = [];
  for (const part of result.content) {
    if (part.type === 'text') {
      textParts.push(part.text);
      continue;
    }
    if (textParts.length) {
      content.push({ type: 'text', text: textParts.join('\n') });
      textParts.length = 0;
    }
    content.push(part);
  }
  if (textParts.length)
    content.push({ type: 'text', text: textParts.join('\n') });
  return { ...result, content };
}

function addServerListener(server: Server, event: 'close', listener: () => void): void {
  const previous = server.onclose;
  server.onclose = () => {
    previous?.();
    listener();
  };
}

function startHeartbeat(server: Server): void {
  const beat = () => {
    Promise.race([
      server.ping(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('ping timeout')), 5000)),
    ]).then(() => {
      setTimeout(beat, 3000);
    }).catch(() => {
      void server.close();
    });
  };
  beat();
}

async function handleSseRequest(
  createServer: () => Server,
  sessions: Map<string, HttpSessionEntry<SSEServerTransport>>,
  ssePath: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL
): Promise<void> {
  if (req.method === 'GET') {
    const server = createServer();
    const transport = new SSEServerTransport(ssePath, res);
    sessions.set(transport.sessionId, { server, transport });
    res.on('close', () => {
      const entry = sessions.get(transport.sessionId);
      if (!entry)
        return;
      sessions.delete(transport.sessionId);
      void closeTransportServer(entry.server, entry.transport);
    });
    await server.connect(transport);
    return;
  }

  if (req.method === 'POST') {
    const sessionId = url.searchParams.get('sessionId');
    const entry = sessionId ? sessions.get(sessionId) : undefined;
    if (!sessionId || !entry) {
      res.statusCode = 404;
      res.end('Session not found');
      return;
    }
    await entry.transport.handlePostMessage(req, res);
    return;
  }

  res.statusCode = 405;
  res.end('Method not allowed');
}

async function handleStreamableRequest(
  createServer: () => Server,
  sessions: Map<string, HttpSessionEntry<StreamableHTTPServerTransport>>,
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  const sessionId = req.headers['mcp-session-id'];
  const existingEntry = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined;
  if (existingEntry) {
    await existingEntry.transport.handleRequest(req, res);
    return;
  }

  if (req.method !== 'POST') {
    res.statusCode = 400;
    res.end('Invalid request');
    return;
  }

  const server = createServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    onsessioninitialized: async initializedSessionId => {
      sessions.set(initializedSessionId, { server, transport });
      await server.connect(transport);
    },
  });

  transport.onclose = () => {
    if (!transport.sessionId)
      return;
    const entry = sessions.get(transport.sessionId);
    if (!entry)
      return;
    sessions.delete(transport.sessionId);
    void closeTransportServer(entry.server, entry.transport);
  };

  await transport.handleRequest(req, res);
}

async function closeTransportServer(server: Server, transport: Transport): Promise<void> {
  await transport.close().catch(() => {});
  await server.close().catch(() => {});
}

function addressToUrl(address: ReturnType<http.Server['address']>): string {
  if (!address || typeof address === 'string')
    throw new Error('Could not resolve HTTP server address');
  let host = address.address;
  if (host === '0.0.0.0' || host === '::' || host === '::1' || host === '127.0.0.1')
    host = 'localhost';
  else if (host.includes(':'))
    host = `[${host}]`;
  return `http://${host}:${address.port}`;
}

function isAllowedHost(
  req: http.IncomingMessage,
  allowedHosts: string[] | undefined,
  address: ReturnType<http.Server['address']>
): boolean {
  if (!allowedHosts || allowedHosts.length === 0)
    return true;
  if (allowedHosts.includes('*'))
    return true;
  const configured = new Set(allowedHosts.map(host => host.toLowerCase()));
  const serverHost = new URL(addressToUrl(address)).host.toLowerCase();
  configured.add(serverHost);
  const requestHost = req.headers.host?.toLowerCase();
  return !!requestHost && configured.has(requestHost);
}

function cloneMessage(message: JSONRPCMessage): JSONRPCMessage {
  if (typeof structuredClone === 'function')
    return structuredClone(message);
  return JSON.parse(JSON.stringify(message));
}
