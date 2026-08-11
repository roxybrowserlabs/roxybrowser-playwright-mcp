import type { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Server as HttpServer } from "node:http";
import type { Readable, Writable } from "node:stream";
import type { AssetOptions, AssetRoots } from "../assets/types.js";
import type { BrowserContextOptions } from "../types/options.js";

export type RoxyMcpProtocol = "cdp" | "bidi";
export type SessionScreenshotType = "png" | "jpeg" | "webp";
export type SessionScreenshotMimeType = "image/png" | "image/jpeg" | "image/webp";
export type ConsoleMessageLevel = "error" | "warning" | "info" | "debug";

export interface RoxyBrowserConnectArgs {
  protocol: RoxyMcpProtocol;
  endpoint: string;
  browser?: "chromium" | "firefox";
  sessionId?: string;
  assetRoots?: AssetRoots;
  downloadsDir?: string;
  redactText?: (text: string) => string;
  consoleLevel?: ConsoleMessageLevel;
  testIdAttribute?: string;
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
  locators?: Record<string, string> | undefined;
  title: string;
  url: string;
  mainDocumentStatus?: { status: number; statusText?: string | undefined } | undefined;
  console?: BrowserConsoleSummary | undefined;
  consoleLink?: string | undefined;
  events?: BrowserSnapshotEvent[] | undefined;
  retryable?: boolean | undefined;
}

export type BrowserSnapshotEvent =
  | { type: "download-start"; filename: string }
  | { type: "download-finish"; filename: string; path: string };

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
  responseBodyBase64?: string | undefined;
  failureText?: string | undefined;
  mimeType?: string | undefined;
  durationMs?: number | undefined;
}

export interface BrowserNetworkResponseBody {
  text?: string | undefined;
  base64?: string | undefined;
}

export interface BrowserNetworkRoute {
  pattern: string;
  abort?: "blockedbyclient" | undefined;
  status?: number | undefined;
  body?: string | undefined;
  contentType?: string | undefined;
  addHeaders?: Record<string, string> | undefined;
  removeHeaders?: string[] | undefined;
}

export interface BrowserCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Strict" | "Lax" | "None";
  partitionKey?: string;
}

export interface BrowserCookieInput {
  name: string;
  value: string;
  url?: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
  partitionKey?: string;
}

export interface BrowserCookieFilter {
  domain?: string | RegExp;
  name?: string | RegExp;
  path?: string | RegExp;
}

export interface BrowserStorageItem {
  name: string;
  value: string;
}

export interface BrowserStorageState {
  cookies: BrowserCookieInput[];
  origins: Array<{
    origin: string;
    localStorage: BrowserStorageItem[];
    indexedDB?: unknown[];
  }>;
  credentials?: unknown[];
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
  testIdAttribute?: string | undefined;
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
  ariaSnapshot(request?: BrowserSnapshotRequest): Promise<string>;
  consoleMessages(level?: ConsoleMessageLevel, all?: boolean): Promise<BrowserConsoleEntry[]>;
  consoleMessageSummary(): Promise<BrowserConsoleSummary>;
  clearConsoleMessages(): Promise<void>;
  evaluate(expression: string, target?: ClickTarget): Promise<BrowserEvaluateResult>;
  addInitScript(source: string): Promise<void>;
  setContent(html: string): Promise<void>;
  countByRole(role: string, accessibleName: string): Promise<number>;
  textContentsByText(text: string, options?: SessionTextQueryOptions): Promise<string[]>;
  textContent(target: ClickTarget): Promise<string | null>;
  inputValue(target: ClickTarget): Promise<string>;
  isChecked(target: ClickTarget): Promise<boolean>;
  isFileInput(target: ClickTarget): Promise<boolean>;
  prepareForFileUpload?(target: ClickTarget): Promise<void>;
  consumePendingFileChooserTarget?(options?: { timeoutMs?: number }): Promise<ClickTarget | undefined>;
  click(target: ClickTarget, options: SessionClickOptions): Promise<void>;
  drag(start: ClickTarget, end: ClickTarget, options: SessionDragOptions): Promise<void>;
  mouseMove(x: number, y: number, options?: SessionMouseMoveOptions): Promise<void>;
  mouseClick(x: number, y: number, options: SessionMouseClickOptions): Promise<void>;
  mouseDrag(startX: number, startY: number, endX: number, endY: number, options: SessionDragOptions): Promise<void>;
  drop(target: ClickTarget, payload: SessionDropOptions): Promise<void>;
  hover(target: ClickTarget, options?: SessionHoverOptions): Promise<void>;
  focus(target: ClickTarget): Promise<void>;
  clear(target: ClickTarget): Promise<void>;
  formFieldMetadata?(target: ClickTarget): Promise<SessionFormFieldMetadata>;
  navigate(url: string): Promise<void>;
  typeKeyboard(text: string): Promise<void>;
  keyDown(key: string): Promise<void>;
  keyUp(key: string): Promise<void>;
  type(target: ClickTarget, text: string, options?: SessionTypeOptions): Promise<void>;
  press(target: ClickTarget, key: string, modifiers?: Array<"Alt" | "Control" | "ControlOrMeta" | "Meta" | "Shift">): Promise<void>;
  pressKey(key: string, modifiers?: Array<"Alt" | "Control" | "ControlOrMeta" | "Meta" | "Shift">): Promise<void>;
  selectOption(target: ClickTarget, values: string[]): Promise<string[]>;
  check(target: ClickTarget, checked: boolean): Promise<void>;
  goBack(): Promise<void>;
  goForward(): Promise<void>;
  reload(): Promise<void>;
  resize(width: number, height: number): Promise<void>;
  emulateContext?(options: BrowserContextOptions): Promise<void>;
  scroll(
    target: ClickTarget | null,
    deltaX: number,
    deltaY: number,
    options?: SessionScrollOptions
  ): Promise<void>;
  screenshot(options?: SessionScreenshotOptions): Promise<{ data: string; mimeType: SessionScreenshotMimeType }>;
  pdf(): Promise<Buffer>;
  uploadFile(target: ClickTarget, filePaths: string[]): Promise<void>;
  finishFileUpload?(target: ClickTarget): Promise<void>;
  fillForm(fields: SessionFormField[]): Promise<void>;
  hasDialog(): Promise<boolean>;
  handleDialog(accept: boolean, promptText?: string): Promise<void>;
  beginRequestCollection?(): Promise<unknown>;
  endRequestCollection?(state?: unknown): Promise<BrowserNetworkRequest[]>;
  networkRequests(): Promise<BrowserNetworkRequest[]>;
  clearRequests(): Promise<void>;
  setOffline?(offline: boolean): Promise<void>;
  addRoute?(route: BrowserNetworkRoute): Promise<void>;
  routes?(): Promise<BrowserNetworkRoute[]>;
  removeRoute?(pattern?: string): Promise<number>;
  networkRequest(index: number): Promise<BrowserNetworkRequest | undefined>;
  fetchResponseBody(index: number): Promise<BrowserNetworkResponseBody | undefined>;
  cookies?(): Promise<BrowserCookie[]>;
  addCookies?(cookies: ReadonlyArray<BrowserCookieInput>): Promise<void>;
  clearCookies?(options?: BrowserCookieFilter): Promise<void>;
  storageState?(): Promise<BrowserStorageState>;
  setStorageState?(state: BrowserStorageState): Promise<void>;
  webStorageItems?(storageName: "localStorage" | "sessionStorage"): Promise<BrowserStorageItem[]>;
  setWebStorageItem?(storageName: "localStorage" | "sessionStorage", key: string, value: string): Promise<void>;
  removeWebStorageItem?(storageName: "localStorage" | "sessionStorage", key: string): Promise<void>;
  clearWebStorage?(storageName: "localStorage" | "sessionStorage"): Promise<void>;
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

export interface SessionMouseMoveOptions {
  moveDelayMs?: number;
}

export interface SessionMouseClickOptions {
  button?: "left" | "right" | "middle";
  clickCount?: number;
  delay?: number;
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

export interface SessionTextQueryOptions {
  target?: ClickTarget | undefined;
  visible?: boolean | undefined;
}

export interface SessionScreenshotOptions {
  type?: SessionScreenshotType | undefined;
  quality?: number | undefined;
  fullPage?: boolean | undefined;
  scale?: "css" | "device" | undefined;
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
export type ImageResponseMode = "include" | "omit";
export type CodegenMode = "typescript" | "none";

export interface CreateRoxyBrowserMcpServerOptions extends AssetOptions {
  sessionFactory?: BrowserSessionFactory;
  capabilities?: Array<"storage" | "devtools" | "network" | "pdf" | "testing" | "vision">;
  consoleLevel?: ConsoleMessageLevel;
  network?: {
    allowedOrigins?: string[];
    blockedOrigins?: string[];
  };
  imageResponses?: ImageResponseMode;
  codegen?: CodegenMode;
  outputMaxSize?: number;
  testIdAttribute?: string;
  skillMode?: boolean;
  secrets?: Record<string, string>;
  initPage?: string[];
  initScript?: string[];
  timeouts?: {
    action?: number;
    navigation?: number;
    expect?: number;
    settle?: number;
  };
  contextOptions?: BrowserContextOptions;
  viewport?: {
    width: number;
    height: number;
  };
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
  allowedHosts?: string[];
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
  locators?: Record<string, string> | undefined;
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
