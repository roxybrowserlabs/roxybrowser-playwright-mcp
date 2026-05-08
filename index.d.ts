import type { Server as HttpServer } from 'node:http';

import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { BrowserContext, BrowserContextOptions, LaunchOptions } from 'playwright';

export type ToolCapability = 'core' | 'core-tabs' | 'core-install' | 'vision' | 'pdf';

export interface McpConfig {
  browser?: {
    browserName?: 'chromium' | 'firefox' | 'webkit';
    isolated?: boolean;
    userDataDir?: string;
    launchOptions?: LaunchOptions;
    contextOptions?: BrowserContextOptions;
    cdpEndpoint?: string;
    remoteEndpoint?: string;
  };
  server?: {
    port?: number;
    host?: string;
  };
  capabilities?: ToolCapability[];
  saveSession?: boolean;
  saveTrace?: boolean;
  outputDir?: string;
  network?: {
    allowedOrigins?: string[];
    blockedOrigins?: string[];
  };
  imageResponses?: 'allow' | 'omit';
}

export interface ConnectionOptions {
  config?: McpConfig;
  contextGetter?: () => Promise<BrowserContext>;
}

export interface StartServerOptions extends ConnectionOptions {
  port: number;
  host?: string;
  allowedHosts?: string[];
}

export interface BaseConnectionResult {
  close: () => Promise<void>;
}

export interface StartServerResult extends BaseConnectionResult {
  mode: 'http';
  url: string;
  baseUrl: string;
  mcpPath: string;
  ssePath: string;
  httpServer: HttpServer;
}

export interface ConnectStdioResult extends BaseConnectionResult {
  mode: 'stdio';
  server: Server;
  transport: StdioServerTransport;
}

export interface ConnectMemoryResult extends BaseConnectionResult {
  mode: 'memory';
  server: Server;
  clientTransport: Transport;
}

export function createConnection(
  userConfig?: McpConfig,
  contextGetter?: () => Promise<BrowserContext>
): Promise<Server>;

export function connectStdio(options?: ConnectionOptions): Promise<ConnectStdioResult>;
export function connectStdio(
  userConfig?: McpConfig,
  contextGetter?: () => Promise<BrowserContext>
): Promise<ConnectStdioResult>;

export function startServer(options: StartServerOptions): Promise<StartServerResult>;

export function connectMemory(options?: ConnectionOptions): Promise<ConnectMemoryResult>;
export function connectMemory(
  userConfig?: McpConfig,
  contextGetter?: () => Promise<BrowserContext>
): Promise<ConnectMemoryResult>;
