import type { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Server as HttpServer } from "node:http";
import type { Readable, Writable } from "node:stream";

export type RoxyMcpProtocol = "cdp" | "bidi";

export interface RoxyBrowserConnectArgs {
  protocol: RoxyMcpProtocol;
  endpoint: string;
  browser?: "chromium" | "firefox";
}

export interface BrowserTab {
  id: string;
  title: string;
  url: string;
  active: boolean;
}

export interface BrowserSnapshot {
  text: string;
  refs: Record<string, string>;
  title: string;
  url: string;
}

export interface BrowserSnapshotTarget {
  raw: string;
  nodeToken?: string;
  selector?: string;
}

export interface BrowserSnapshotRequest {
  target?: BrowserSnapshotTarget | undefined;
  depth?: number | undefined;
  boxes?: boolean | undefined;
}

export interface BrowserSnapshotToolArgs {
  target?: string | undefined;
  filename?: string | undefined;
  depth?: number | undefined;
  boxes?: boolean | undefined;
}

export interface ConnectedBrowserSession {
  readonly protocol: RoxyMcpProtocol;
  readonly browserName: "chromium" | "firefox";
  version(): Promise<string>;
  listTabs(): Promise<BrowserTab[]>;
  newTab(url?: string): Promise<BrowserTab[]>;
  selectTab(tabId: string): Promise<BrowserTab[]>;
  closeTab(tabId: string): Promise<BrowserTab[]>;
  snapshot(request?: BrowserSnapshotRequest): Promise<BrowserSnapshot>;
  click(target: ClickTarget, options: SessionClickOptions): Promise<void>;
  hover(target: ClickTarget): Promise<void>;
  close(): Promise<void>;
}

export type ClickTarget = { nodeToken: string } | { selector: string };

export interface SessionClickOptions {
  doubleClick?: boolean;
  button?: "left" | "right" | "middle";
  modifiers?: Array<"Alt" | "Control" | "ControlOrMeta" | "Meta" | "Shift">;
  clickHoldMs: number;
}

export type BrowserSessionFactory = (
  args: RoxyBrowserConnectArgs
) => Promise<ConnectedBrowserSession>;

export type SnapshotMode = "full" | "none";

export interface CreateRoxyBrowserMcpServerOptions {
  sessionFactory?: BrowserSessionFactory;
  serverInfo?: {
    name?: string;
    version?: string;
  };
  snapshotMode?: SnapshotMode;
}

export interface StartRoxyBrowserMcpHttpOptions extends CreateRoxyBrowserMcpServerOptions {
  host?: string;
  port: number;
  path?: string;
}

export interface StartRoxyBrowserMcpStdioOptions extends CreateRoxyBrowserMcpServerOptions {
  stdin?: Readable;
  stdout?: Writable;
}

export interface SnapshotCacheEntry {
  tabId: string;
  requestKey: string;
  text: string;
  refs: Record<string, string>;
  title: string;
  url: string;
}

export interface RoxyBrowserMcpServerBundle {
  server: McpServer;
  runtimeManager: import("./runtime.js").McpRuntimeManager;
  close(): Promise<void>;
}

export interface RoxyBrowserMcpStdioBundle {
  server: McpServer;
  transport: StdioServerTransport;
  close(): Promise<void>;
}

export interface RoxyBrowserMcpInMemoryBundle {
  server: McpServer;
  serverTransport: InMemoryTransport;
  clientTransport: InMemoryTransport;
  close(): Promise<void>;
}

export interface RoxyBrowserMcpHttpBundle {
  server: McpServer;
  httpServer: HttpServer;
  close(): Promise<void>;
}
