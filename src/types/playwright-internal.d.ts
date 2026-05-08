type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends Array<infer U>
    ? Array<U>
    : T[K] extends object
      ? DeepPartial<T[K]>
      : T[K];
};

type BrowserName = 'chromium' | 'firefox' | 'webkit';
type BrowserChannel =
  | 'chrome'
  | 'chrome-beta'
  | 'chrome-canary'
  | 'chrome-dev'
  | 'chromium'
  | 'msedge'
  | 'msedge-beta'
  | 'msedge-canary'
  | 'msedge-dev';
type ConsoleLevel = 'error' | 'warning' | 'info' | 'debug';
type OutputMode = 'file' | 'stdout';
type SnapshotMode = 'incremental' | 'full' | 'none';
type ToolCapability =
  | 'core'
  | 'core-tabs'
  | 'core-install'
  | 'vision'
  | 'pdf'
  | 'internal'
  | 'tracing';
type ToolType = 'action' | 'readOnly' | 'destructive' | 'input';
type Resolution = { width: number; height: number };

interface PlaywrightMcpConfig {
  browser: {
    browserName: BrowserName;
    isolated?: boolean;
    userDataDir?: string;
    launchOptions?: import('playwright').LaunchOptions & {
      assistantMode?: boolean;
      cdpPort?: number;
      channel?: BrowserChannel;
    };
    contextOptions?: import('playwright').BrowserContextOptions;
    cdpEndpoint?: string;
    cdpHeaders?: Record<string, string>;
    cdpTimeout?: number;
    remoteEndpoint?: string;
    initPage?: string[];
    initScript?: string[];
  };
  server?: {
    port?: number;
    host?: string;
    allowedHosts?: string[];
  };
  capabilities?: ToolCapability[];
  console?: {
    level?: ConsoleLevel;
  };
  network?: {
    allowedOrigins?: string[];
    blockedOrigins?: string[];
  };
  snapshot?: {
    mode?: SnapshotMode;
    output?: OutputMode;
  };
  timeouts?: {
    action?: number;
    navigation?: number;
  };
  allowUnrestrictedFileAccess?: boolean;
  codegen?: 'none' | 'typescript';
  imageResponses?: 'allow' | 'omit';
  outputDir?: string;
  outputMode?: OutputMode;
  saveSession?: boolean;
  saveTrace?: boolean;
  saveVideo?: Resolution;
  secrets?: Record<string, string>;
  sharedBrowserContext?: boolean;
  testIdAttribute?: string;
  [key: string]: unknown;
}

type PlaywrightMcpConfigInput = DeepPartial<PlaywrightMcpConfig> & Record<string, unknown>;

interface PlaywrightMcpClientInfo {
  cwd?: string;
  clientName?: string;
  timestamp?: number;
  roots?: Array<{ uri: string }>;
  [key: string]: unknown;
}

interface BrowserContextFactoryResult {
  browserContext: import('playwright').BrowserContext;
  close: () => Promise<void> | void;
}

interface PlaywrightMcpBrowserContextFactory {
  createContext(
    clientInfo: PlaywrightMcpClientInfo,
    abortSignal?: AbortSignal,
    options?: Record<string, unknown>
  ): Promise<BrowserContextFactoryResult>;
  dispose?(): Promise<void> | void;
}

interface PlaywrightMcpTab {
  page: import('playwright').Page;
  refLocator(args: { ref: string; [key: string]: unknown }): Promise<{ locator: import('playwright').Locator }>;
  waitForCompletion<T>(task: () => Promise<T>): Promise<T>;
  [key: string]: unknown;
}

interface PlaywrightMcpToolContext {
  config: PlaywrightMcpConfig;
  _browserContextFactory: PlaywrightMcpBrowserContextFactory;
  closeBrowserContext(): Promise<void>;
  ensureTab(): Promise<PlaywrightMcpTab>;
  setRunningTool?(name: string | undefined): void;
  dispose?(): Promise<void>;
  [key: string]: unknown;
}

type PlaywrightMcpToolDefinition = import('@modelcontextprotocol/sdk/types.js').Tool;
type PlaywrightMcpToolResult = import('@modelcontextprotocol/sdk/types.js').CallToolResult & {
  isClose?: boolean;
};

interface RoxyExtraToolSchema<TArgs = unknown> {
  name: string;
  title: string;
  description: string;
  inputSchema: import('zod').ZodType<TArgs>;
  type?: ToolType;
}

interface RoxyExtraTool<TArgs = unknown> {
  schema: RoxyExtraToolSchema<TArgs>;
  handle: (
    context: import('playwright/lib/mcp/browserServerBackend').ToolContext,
    args: TArgs,
    progress?: unknown
  ) => Promise<import('playwright/lib/mcp/browserServerBackend').ToolResult>;
}

declare module 'playwright/lib/mcp/browser/config' {
  export type Config = PlaywrightMcpConfig;
  export type ConfigInput = PlaywrightMcpConfigInput;
  export type ToolCapability =
    | 'core'
    | 'core-tabs'
    | 'core-install'
    | 'vision'
    | 'pdf'
    | 'internal'
    | 'tracing';

  export const defaultConfig: Config;

  export function resolveConfig(config?: ConfigInput): Promise<Config>;
  export function resolveCLIConfig(cliOptions?: Record<string, unknown>): Promise<Config>;
  export function configFromEnv(): ConfigInput;

  export function commaSeparatedList(value?: string): string[] | undefined;
  export function semicolonSeparatedList(value?: string): string[] | undefined;
  export function dotenvFileLoader(value?: string): Record<string, string> | undefined;
  export function numberParser(value?: string): number | undefined;
  export function resolutionParser(name: string, value?: string): Resolution | undefined;
  export function headerParser(
    arg?: string,
    previous?: Record<string, string>
  ): Record<string, string>;
  export function enumParser<T extends string>(
    name: string,
    options: readonly T[],
    value: T
  ): T;
  export function outputDir(config: Config, clientInfo: PlaywrightMcpClientInfo): string | undefined;
  export function outputFile(
    config: Config,
    clientInfo: PlaywrightMcpClientInfo,
    fileName: string,
    options: { origin: 'code' | 'llm' | string; title: string }
  ): Promise<string>;
}

declare module 'playwright/lib/mcp/browser/browserContextFactory' {
  export interface BrowserContextFactory extends PlaywrightMcpBrowserContextFactory {}

  export function contextFactory(config: PlaywrightMcpConfig): BrowserContextFactory;
  export function identityBrowserContextFactory(
    browserContext: import('playwright').BrowserContext
  ): BrowserContextFactory;

  export class SharedContextFactory implements BrowserContextFactory {
    static create(config: PlaywrightMcpConfig): SharedContextFactory;
    static dispose(): Promise<void>;

    createContext(
      clientInfo: PlaywrightMcpClientInfo,
      abortSignal?: AbortSignal,
      options?: Record<string, unknown>
    ): Promise<BrowserContextFactoryResult>;
  }
}

declare module 'playwright/lib/mcp/browserServerBackend' {
  export interface ToolContext extends PlaywrightMcpToolContext {}
  export interface ToolResult extends PlaywrightMcpToolResult {}

  export class BrowserServerBackend {
    protected _config: PlaywrightMcpConfig;
    protected _browserContextFactory: PlaywrightMcpBrowserContextFactory;
    protected _context: PlaywrightMcpToolContext;

    constructor(config: PlaywrightMcpConfig, factory: PlaywrightMcpBrowserContextFactory);
    initialize(clientInfo: PlaywrightMcpClientInfo): Promise<void>;
    listTools(): Promise<PlaywrightMcpToolDefinition[]>;
    callTool(name: string, rawArguments?: unknown, progress?: unknown): Promise<ToolResult>;
    serverClosed(server?: unknown): void;
    dispose?(): Promise<void> | void;
  }
}

declare module 'playwright/lib/mcp/program' {
  export function decorateCommand(
    command: import('commander').Command,
    version: string
  ): void;
}
