import type { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Server as HttpServer } from "node:http";
import type { Readable, Writable } from "node:stream";
import type { AssetOptions, AssetRoots } from "../assets/types.js";

export type RoxyMcpProtocol = "cdp" | "bidi";

export interface RoxyBrowserConnectArgs {
  protocol: RoxyMcpProtocol;
  endpoint: string;
  browser?: "chromium" | "firefox";
  sessionId?: string;
  assetRoots?: AssetRoots;
}

export interface RoxyBrowserLaunchOpenArgs {
  workspaceId: number;
  dirId: string;
  forceOpen?: boolean;
  args?: string[];
}

export interface RoxyBrowserLaunchApiResponse<TData = unknown> {
  code?: number;
  msg?: string;
  data?: TData;
}

export interface RoxyBrowserLaunchClient {
  getConnectionInfo(dirIds?: string[]): Promise<RoxyBrowserLaunchApiResponse>;
  openBrowser(args: RoxyBrowserLaunchOpenArgs): Promise<RoxyBrowserLaunchApiResponse>;
}

export interface RoxyBrowserLaunchClientConfig {
  workspaceId: number;
  client: RoxyBrowserLaunchClient;
}

export interface RoxyBrowserLaunchClientOptions {
  workspaceId: number;
  apiToken: string;
  apiPort?: string | number;
  host?: string;
}

export type RoxyBrowserLaunchConfig =
  | RoxyBrowserLaunchClientConfig
  | RoxyBrowserLaunchClientOptions;

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
  retryable?: boolean | undefined;
}

export interface BrowserEvaluateResult {
  result: unknown;
  isFunction: boolean;
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
  requestKey?: string | undefined;
  redirectedFromRequestKey?: string | undefined;
  redirectedToRequestKey?: string | undefined;
  finalRequestKey?: string | undefined;
  method: string;
  url: string;
  resourceType: string;
  isNavigationRequest?: boolean | undefined;
  requestHeaders: Record<string, string>;
  rawRequestHeaders?: Record<string, string> | undefined;
  requestBody?: string | undefined;
  status?: number | undefined;
  statusText?: string | undefined;
  responseHeaders?: Record<string, string> | undefined;
  rawResponseHeaders?: Record<string, string> | undefined;
  responseHeadersSize?: number | undefined;
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
  evaluate(expression: string, target?: ClickTarget): Promise<BrowserEvaluateResult>;
  isFileInput(target: ClickTarget): Promise<boolean>;
  prepareForFileUpload?(target: ClickTarget): Promise<void>;
  consumePendingFileChooserTarget?(options?: { timeoutMs?: number }): Promise<ClickTarget | undefined>;
  click(target: ClickTarget, options: SessionClickOptions): Promise<void>;
  drag(start: ClickTarget, end: ClickTarget, options: SessionDragOptions): Promise<void>;
  drop(target: ClickTarget, payload: SessionDropOptions): Promise<void>;
  hover(target: ClickTarget, options?: SessionHoverOptions): Promise<void>;
  focus(target: ClickTarget): Promise<void>;
  clear(target: ClickTarget): Promise<void>;
  formFieldMetadata?(target: ClickTarget): Promise<SessionFormFieldMetadata>;
  navigate(url: string): Promise<void>;
  type(target: ClickTarget, text: string, options?: SessionTypeOptions): Promise<void>;
  pressKey(key: string, modifiers?: Array<"Alt" | "Control" | "ControlOrMeta" | "Meta" | "Shift">): Promise<void>;
  selectOption(target: ClickTarget, values: string[]): Promise<string[]>;
  check(target: ClickTarget, checked: boolean): Promise<void>;
  goBack(): Promise<void>;
  goForward(): Promise<void>;
  resize(width: number, height: number): Promise<void>;
  scroll(
    target: ClickTarget | null,
    deltaX: number,
    deltaY: number,
    options?: SessionScrollOptions
  ): Promise<void>;
  screenshot(options?: SessionScreenshotOptions): Promise<{ data: string; mimeType: "image/png" | "image/jpeg" }>;
  uploadFile(target: ClickTarget, filePaths: string[]): Promise<void>;
  finishFileUpload?(target: ClickTarget): Promise<void>;
  fillForm(fields: SessionFormField[]): Promise<void>;
  hasDialog(): Promise<boolean>;
  handleDialog(accept: boolean, promptText?: string): Promise<void>;
  beginRequestCollection?(): Promise<unknown>;
  endRequestCollection?(state?: unknown): Promise<BrowserNetworkRequest[]>;
  networkRequests(): Promise<BrowserNetworkRequest[]>;
  networkRequest(index: number): Promise<BrowserNetworkRequest | undefined>;
  fetchResponseBody(index: number): Promise<string | undefined>;
  waitForPageTimeout?(timeoutMs: number): Promise<void>;
  waitForMainFrameLoad?(timeoutMs: number): Promise<void>;
  waitForRequestFinished?(requestId: string, timeoutMs: number): Promise<void>;
  waitForRequestResponse?(requestId: string, timeoutMs: number): Promise<void>;
  ensureActiveCursorVisualization(): Promise<void>;
  runCodeUnsafe(code: string): Promise<unknown>;
  close(): Promise<void>;
}

export type ClickTarget =
  | { nodeToken: string }
  | { selector: string }
  | { backendNodeId: number };

export interface SessionClickOptions {
  doubleClick?: boolean;
  button?: "left" | "right" | "middle";
  modifiers?: Array<"Alt" | "Control" | "ControlOrMeta" | "Meta" | "Shift">;
  clickHoldMs: number;
  moveDelayMs?: number;
}

export interface SessionHoverOptions {
  moveDelayMs?: number;
}

export interface SessionTypeOptions {
  submit?: boolean;
  slowly?: boolean;
  strategy?: "sequential" | "fill";
  delayMs?: number;
  /** Per-keystroke delay variance (ms) for humanized typing on the CDP per-char path. */
  varianceMs?: number;
}

export interface SessionScrollOptions {
  stepPx: number;
  stepDelayMs: number;
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
  type: "textbox" | "checkbox" | "radio" | "combobox" | "slider" | "value";
  value: string;
}

export interface SessionFormFieldMetadata {
  tagName: string;
  inputType?: string | undefined;
  isContentEditable?: boolean | undefined;
}

export type BrowserSessionFactory = (
  args: RoxyBrowserConnectArgs
) => Promise<ConnectedBrowserSession>;

export type SnapshotMode = "full" | "none";

export interface CreateRoxyBrowserMcpServerOptions extends AssetOptions {
  sessionFactory?: BrowserSessionFactory;
  serverInfo?: {
    name?: string;
    version?: string;
  };
  snapshotMode?: SnapshotMode;
}

export interface CreateRoxyBrowserMcpInMemoryOptions extends CreateRoxyBrowserMcpServerOptions {
  roxyBrowserLaunch?: RoxyBrowserLaunchConfig;
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
  getLastSessionId?(): string | undefined;
  close(): Promise<void>;
}

export interface RoxyBrowserMcpStdioBundle {
  server: McpServer;
  transport: StdioServerTransport;
  close(): Promise<void>;
}

export interface RoxyBrowserMcpInMemoryBundle {
  server: McpServer;
  runtimeManager: import("./runtime.js").McpRuntimeManager;
  getLastSessionId?(): string | undefined;
  serverTransport: InMemoryTransport;
  clientTransport: InMemoryTransport;
  close(): Promise<void>;
}

export interface RoxyBrowserMcpHttpBundle {
  server: McpServer;
  httpServer: HttpServer;
  close(): Promise<void>;
}
