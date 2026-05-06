/**
 * @roxybrowser/playwright-mcp
 *
 * 提供两种使用方式：
 * 1. CLI：npx @roxybrowser/playwright-mcp [--port 9324]
 * 2. 程序化：createConnection（stdio/自定义 transport）、startServer（HTTP，Studio 协议）
 *
 * 工具类导出供第三方扩展或嵌入。
 */
import { createRequire } from 'node:module';

import {
  CustomBackend,
  DynamicCdpContextFactory,
  defineExtraTool,
  extraToolToMcp,
} from './backend/index.js';
import { createServer, start } from 'playwright/lib/mcp/sdk/exports';
import { resolveConfig, configFromEnv } from 'playwright/lib/mcp/browser/config';
import { contextFactory } from 'playwright/lib/mcp/browser/browserContextFactory';
import mcpBundle from 'playwright-core/lib/mcpBundle';
import os from 'os';

const require = createRequire(import.meta.url);
const pkg = { version: typeof __VERSION__ !== 'undefined' ? __VERSION__ : require('../package.json').version };

/**
 * 创建 MCP 服务端实例（未连接 transport）。
 * 使用 CustomBackend（含官方 Playwright 工具 + browser_connect_roxy）。
 * 适用于：自管 stdio/HTTP transport、嵌入到其他应用。
 *
 * @param {object} [userConfig] - 与 Playwright MCP 一致的 config，会与默认 config 合并
 * @param {() => Promise<import('playwright').BrowserContext>} [contextGetter] - 可选，返回已有 BrowserContext 时用该 context 作为后端
 * @returns {Promise<import('@modelcontextprotocol/sdk').Server>} 已就绪的 MCP Server，需再 connect(transport)
 */
export async function createConnection(userConfig = {}, contextGetter) {
  const config = await resolveConfig(userConfig);
  const factory = contextGetter
    ? {
        createContext: async () => {
          const browserContext = await contextGetter();
          return {
            browserContext,
            close: () => browserContext.close(),
          };
        },
      }
    : contextFactory(config);
  const backend = new CustomBackend(config, factory);
  const server = await createServer(
    'Playwright+Roxy',
    pkg.version,
    backend,
    false
  );
  await server.connect(new mcpBundle.StdioServerTransport());
}

/**
 * 以 HTTP/SSE 方式启动 MCP 服务（Studio 协议），便于第三方通过 URL 连接。
 * 进程会持续运行直到退出；返回的 url 可供客户端配置使用。
 *
 * @param {object} options
 * @param {number} options.port - 监听端口（必填）
 * @param {string} [options.host='localhost'] - 监听地址
 * @param {object} [options.config] - 其他 MCP/浏览器 config，与 resolveConfig 合并
 * @returns {Promise<{ url: string }>} 客户端连接用的 MCP URL（如 http://localhost:9324/mcp）
 */
export async function startServer(options = {}) {
  const { port, host = 'localhost', config: configOverrides = {} } = options;
  if (port == null) throw new Error('startServer(options) requires options.port');

  const config = await resolveConfig(configOverrides);
  config.server = { port: Number(port), host };

  const browserContextFactory = contextFactory(config);
  const serverBackendFactory = {
    name: 'Playwright+Roxy',
    nameInConfig: 'playwright',
    version: pkg.version,
    create: () => new CustomBackend(config, browserContextFactory),
  };

  await start(serverBackendFactory, config.server);

  const url = `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}/mcp`;
  return { url };
}

export class RoxyBrowserPlaywrightMCPServer {
  server
  constructor(userConfig = {}) {
    const config = Object.assign({
      browser: {
        browserName: "chromium",
        launchOptions: {
          channel: "chrome",
          headless: os.platform() === "linux" && !process.env.DISPLAY,
          chromiumSandbox: true
        },
        contextOptions: {
          viewport: null
        }
      },
      console: {
        level: "info"
      },
      network: {
        allowedOrigins: void 0,
        blockedOrigins: void 0
      },
      server: {},
      saveTrace: false,
      snapshot: {
        mode: "incremental",
        output: "stdout"
      },
      timeouts: {
        action: 5e3,
        navigation: 6e4
      }
    }, userConfig);
    const factory = contextFactory(config);
    const backend = new CustomBackend(config, factory);
    this.server = createServer(
      'roxybrowser-playwright-mcp',
      pkg.version,
      backend,
      false
    );
  }

  /**
   * 连接 transport（stdio / InMemoryTransport 等）
   * @param {object} transport - 符合 MCP Transport 接口的对象
   */
  async connect(transport) {
    if (!this.server)
      throw new Error('Server not created. Call createServer() before connect().');
    await this.server.connect(transport);
  }

  /**
   * 按模式运行 server
   * @param {'stdio'} mode - 运行模式
   * @param {object} [transport] - 可选的自定义 transport（忽略 mode）
   */
  async run(mode, transport) {
    if (!this.server)
      throw new Error('Server not created. Call createServer() before run().');
    if (transport) {
      return this.server.connect(transport);
    }
    switch(mode) {
      case "stdio":
        return this.server.connect(new mcpBundle.StdioServerTransport());
      default:
        return this.server.connect(new mcpBundle.StdioServerTransport());
    }
  }
}

export {
  CustomBackend,
  DynamicCdpContextFactory,
  defineExtraTool,
  extraToolToMcp,
  configFromEnv
};
