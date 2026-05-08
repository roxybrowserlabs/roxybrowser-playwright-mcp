/**
 * @roxybrowser/playwright-mcp
 *
 * Public programmatic API:
 * 1. `startServer()` for HTTP/SSE startup
 * 2. `connectStdio()` for stdio startup
 * 3. `connectMemory()` for in-process memory transport startup
 * 4. `createConnection()` for self-managed transports
 */
import { createRequire } from 'node:module';

import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { BrowserContext } from 'playwright';
import type { BrowserContextFactory } from 'playwright/lib/mcp/browser/browserContextFactory';
import type { Config, ConfigInput } from 'playwright/lib/mcp/browser/config';

import { CustomBackend } from './backend/CustomBackend.js';
import {
  connectStdio as connectStdioTransport,
  createMcpServer,
  createMemoryTransportPair,
  startHttpTransport,
} from './mcp/service.js';
import { resolveConfig } from 'playwright/lib/mcp/browser/config';
import { contextFactory } from 'playwright/lib/mcp/browser/browserContextFactory';

const require = createRequire(import.meta.url);
const pkg = {
  version:
    typeof __VERSION__ !== 'undefined' ? __VERSION__ : require('../package.json').version,
};

type ConnectionOptions = {
  config?: ConfigInput;
  contextGetter?: () => Promise<BrowserContext>;
};

type HttpServerOptions = ConnectionOptions & {
  port: number;
  host?: string;
  allowedHosts?: string[];
};

type StdioConnection = {
  mode: 'stdio';
  server: Server;
  transport: import('@modelcontextprotocol/sdk/server/stdio.js').StdioServerTransport;
  close: () => Promise<void>;
};

type HttpConnection = {
  mode: 'http';
  url: string;
  baseUrl: string;
  mcpPath: string;
  ssePath: string;
  httpServer: import('node:http').Server;
  close: () => Promise<void>;
};

type MemoryConnection = {
  mode: 'memory';
  server: Server;
  clientTransport: Transport;
  close: () => Promise<void>;
};

/**
 * Creates an MCP server instance without connecting a transport.
 */
export async function createConnection(
  userConfig: ConfigInput = {},
  contextGetter?: () => Promise<BrowserContext>
): Promise<Server> {
  const config = await resolveConfig(userConfig);
  return createConfiguredServer(config, contextGetter);
}

/**
 * Starts a stdio MCP server and connects it immediately.
 */
export async function connectStdio(
  options: ConnectionOptions = {}
): Promise<StdioConnection>;
export async function connectStdio(
  userConfig?: ConfigInput,
  contextGetter?: () => Promise<BrowserContext>
): Promise<StdioConnection>;
export async function connectStdio(
  optionsOrConfig: ConnectionOptions | ConfigInput = {},
  contextGetter?: () => Promise<BrowserContext>
): Promise<StdioConnection> {
  const { config, contextGetter: resolvedContextGetter } = normalizeConnectionOptions(
    optionsOrConfig,
    contextGetter
  );
  const resolvedConfig = await resolveConfig(config);
  const result = await connectStdioTransport(() => createConfiguredServer(resolvedConfig, resolvedContextGetter));
  return {
    mode: 'stdio',
    ...result,
    close: async () => {
      await result.transport.close().catch(() => {});
      await result.server.close().catch(() => {});
    },
  };
}

/**
 * Starts an HTTP/SSE MCP server and returns the connectable URL.
 */
export async function startServer(options: HttpServerOptions): Promise<HttpConnection> {
  const {
    port,
    host = 'localhost',
    config: configOverrides = {},
    contextGetter,
    allowedHosts,
  } = options;
  if (port == null)
    throw new Error('startServer(options) requires options.port');

  const config = await resolveConfig(configOverrides);
  config.server = { port: Number(port), host };
  const result = await startHttpTransport(
    () => createConfiguredServer(config, contextGetter, { runHeartbeat: true }),
    {
      host,
      port: Number(port),
      allowedHosts,
    }
  );
  return {
    mode: 'http',
    ...result,
  };
}

/**
 * Starts an in-memory MCP server and returns the client-side transport.
 */
export async function connectMemory(
  options: ConnectionOptions = {}
): Promise<MemoryConnection>;
export async function connectMemory(
  userConfig?: ConfigInput,
  contextGetter?: () => Promise<BrowserContext>
): Promise<MemoryConnection>;
export async function connectMemory(
  optionsOrConfig: ConnectionOptions | ConfigInput = {},
  contextGetter?: () => Promise<BrowserContext>
): Promise<MemoryConnection> {
  const { config, contextGetter: resolvedContextGetter } = normalizeConnectionOptions(
    optionsOrConfig,
    contextGetter
  );
  const resolvedConfig = await resolveConfig(config);
  const server = createConfiguredServer(resolvedConfig, resolvedContextGetter);
  const { client, server: serverTransport } = createMemoryTransportPair();
  await server.connect(serverTransport);
  return {
    mode: 'memory',
    server,
    clientTransport: client,
    close: async () => {
      await serverTransport.close().catch(() => {});
      await server.close().catch(() => {});
    },
  };
}

function normalizeConnectionOptions(
  optionsOrConfig: ConnectionOptions | ConfigInput,
  contextGetter?: () => Promise<BrowserContext>
): Required<ConnectionOptions> {
  if ('config' in optionsOrConfig || 'contextGetter' in optionsOrConfig) {
    return {
      config: optionsOrConfig.config ?? {},
      contextGetter: optionsOrConfig.contextGetter,
    };
  }
  return {
    config: optionsOrConfig,
    contextGetter,
  };
}

function createConfiguredServer(
  config: Config,
  contextGetter?: () => Promise<BrowserContext>,
  options: { runHeartbeat?: boolean } = {}
): Server {
  const browserContextFactory = createBrowserContextFactory(config, contextGetter);
  return createMcpServer({
    name: 'Playwright+Roxy',
    version: pkg.version,
    createBackend: async () => new CustomBackend(config, browserContextFactory),
    runHeartbeat: options.runHeartbeat,
  });
}

function createBrowserContextFactory(
  config: Config,
  contextGetter?: () => Promise<BrowserContext>
): BrowserContextFactory {
  if (!contextGetter)
    return contextFactory(config);
  return {
    createContext: async () => {
      const browserContext = await contextGetter();
      return {
        browserContext,
        close: () => browserContext.close(),
      };
    },
  };
}
