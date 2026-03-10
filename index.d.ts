/**
 * @roxybrowser/playwright-mcp
 * 类型声明：CLI + 程序化 createConnection/startServer + 可扩展 Backend/工具
 */
import type { BrowserContext } from 'playwright';

/** 与 Playwright MCP 一致的配置（部分常用字段） */
export interface McpConfig {
  browser?: {
    browserName?: string;
    isolated?: boolean;
    userDataDir?: string;
    launchOptions?: Record<string, unknown>;
    contextOptions?: Record<string, unknown>;
    cdpEndpoint?: string;
  };
  server?: { port?: number; host?: string };
  [key: string]: unknown;
}

/**
 * 创建 MCP 服务端实例（未连接 transport）。
 * 使用 CustomBackend（官方工具 + browser_connect_roxy）。需再 server.connect(transport)。
 */
export function createConnection(
  userConfig?: McpConfig,
  contextGetter?: () => Promise<BrowserContext>
): Promise<import('@modelcontextprotocol/sdk').Server>;

/**
 * 以 HTTP/SSE 启动 MCP 服务（Studio 协议），返回可连接的 URL。
 * 进程会持续运行直到退出。
 */
export function startServer(options: {
  port: number;
  host?: string;
  config?: McpConfig;
}): Promise<{ url: string }>;

/** 自定义 Backend，继承 Playwright BrowserServerBackend 并增加 Roxy 等工具 */
export class CustomBackend {
  constructor(config: McpConfig, factory: unknown);
  listTools(): Promise<unknown[]>;
  callTool(name: string, rawArguments: unknown, progress?: (p?: unknown) => void): Promise<unknown>;
  serverClosed?(server?: unknown): void;
}

/** 支持 reconnectToCDP 的浏览器上下文工厂，用于 Roxy 连接 */
export class DynamicCdpContextFactory {
  constructor(config: McpConfig, initialCdpEndpoint?: string);
  reconnectToCDP(cdpEndpoint: string): void;
  createContext(
    clientInfo: unknown,
    abortSignal?: AbortSignal,
    options?: Record<string, unknown>
  ): Promise<{ browserContext: BrowserContext; close: () => Promise<void> }>;
}

/** 定义额外工具的 schema + handle 的辅助函数 */
export function defineExtraTool<TArgs>(
  schema: {
    name: string;
    title: string;
    description: string;
    inputSchema: import('zod').ZodType<TArgs>;
    type?: 'action' | 'readOnly' | 'destructive';
  },
  handle: (context: unknown, args: TArgs, progress?: (params?: unknown) => void) => Promise<{
    content: Array<{ type: 'text'; text: string }>;
    isError?: boolean;
  }>
): { schema: typeof schema; handle: typeof handle };

/** 将自定义 tool 的 schema 转为 MCP listTools 返回格式 */
export function extraToolToMcp(schema: {
  name: string;
  description: string;
  title: string;
  inputSchema: unknown;
  type?: string;
}): {
  name: string;
  description: string;
  inputSchema: object;
  annotations: object;
};
