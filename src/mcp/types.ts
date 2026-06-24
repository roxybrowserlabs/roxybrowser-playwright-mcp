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
  console?: BrowserConsoleSummary | undefined;
  consoleLink?: string | undefined;
}

export interface BrowserConsoleSummary {
  total: number;
  errors: number;
  warnings: number;
}

export interface BrowserConsoleEntry {
  type: string;
  text: string;
  timestamp: number;
  locationUrl?: string | undefined;
  lineNumber?: number | undefined;
  formattedText: string;
}

export interface BrowserNetworkRequest {
  index: number;
  requestId: string;
  method: string;
  url: string;
  resourceType: string;
  requestHeaders: Record<string, string>;
  requestBody?: string | undefined;
  status?: number | undefined;
  statusText?: string | undefined;
  responseHeaders?: Record<string, string> | undefined;
  responseBody?: string | undefined;
  failureText?: string | undefined;
  mimeType?: string | undefined;
  durationMs?: number | undefined;
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
  consoleMessages(level?: "error" | "warning" | "info" | "debug", all?: boolean): Promise<BrowserConsoleEntry[]>;
  evaluate(expression: string, target?: ClickTarget): Promise<unknown>;
  isFileInput(target: ClickTarget): Promise<boolean>;
  click(target: ClickTarget, options: SessionClickOptions): Promise<void>;
  drag(start: ClickTarget, end: ClickTarget, options: SessionDragOptions): Promise<void>;
  drop(target: ClickTarget, payload: SessionDropOptions): Promise<void>;
  hover(target: ClickTarget): Promise<void>;
  navigate(url: string): Promise<void>;
  type(target: ClickTarget, text: string, options?: SessionTypeOptions): Promise<void>;
  pressKey(key: string, modifiers?: Array<"Alt" | "Control" | "ControlOrMeta" | "Meta" | "Shift">): Promise<void>;
  selectOption(target: ClickTarget, values: string[]): Promise<string[]>;
  check(target: ClickTarget, checked: boolean): Promise<void>;
  goBack(): Promise<void>;
  goForward(): Promise<void>;
  resize(width: number, height: number): Promise<void>;
  scroll(target: ClickTarget | null, deltaX: number, deltaY: number): Promise<void>;
  screenshot(options?: SessionScreenshotOptions): Promise<{ data: string; mimeType: "image/png" | "image/jpeg" }>;
  uploadFile(target: ClickTarget, filePaths: string[]): Promise<void>;
  fillForm(fields: SessionFormField[]): Promise<void>;
  handleDialog(accept: boolean, promptText?: string): Promise<void>;
  networkRequests(): Promise<BrowserNetworkRequest[]>;
  networkRequest(index: number): Promise<BrowserNetworkRequest | undefined>;
  runCodeUnsafe(code: string): Promise<unknown>;
  close(): Promise<void>;
}

export type ClickTarget = { nodeToken: string } | { selector: string };

export interface SessionClickOptions {
  doubleClick?: boolean;
  button?: "left" | "right" | "middle";
  modifiers?: Array<"Alt" | "Control" | "ControlOrMeta" | "Meta" | "Shift">;
  clickHoldMs: number;
}

export interface SessionTypeOptions {
  submit?: boolean;
  slowly?: boolean;
  delayMs?: number;
}

export interface SessionDragOptions {
  moveDelayMs: number;
  holdDelayMs: number;
}

export interface SessionDropOptions {
  paths?: string[] | undefined;
  data?: Record<string, string> | undefined;
}

export interface SessionScreenshotOptions {
  type?: "png" | "jpeg" | undefined;
  fullPage?: boolean | undefined;
  target?: ClickTarget | undefined;
}

export interface SessionFormField {
  target: ClickTarget;
  type: "textbox" | "checkbox" | "radio" | "combobox" | "slider";
  value: string;
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
  outputDir?: string;
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
  console?: BrowserConsoleSummary | undefined;
  consoleLink?: string | undefined;
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
