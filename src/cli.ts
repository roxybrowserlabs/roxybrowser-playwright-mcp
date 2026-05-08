#!/usr/bin/env node
/**
 * Roxybrowser Playwright MCP Server（方案一：CustomBackend 包装官方 backend + 自定义工具）
 *
 * 使用 pnpm patch 暴露的 playwright MCP 模块；CLI 沿用官方选项，backend 替换为 CustomBackend。
 */
import { createRequire } from 'node:module';
import { CustomBackend } from './backend/index.js';
import { decorateCommand } from 'playwright/lib/mcp/program';
import { connectStdio, createMcpServer, startHttpTransport } from './mcp/service.js';
import { resolveCLIConfig } from 'playwright/lib/mcp/browser/config';
import { contextFactory } from 'playwright/lib/mcp/browser/browserContextFactory';
import { program } from 'commander';

const require = createRequire(import.meta.url);
const pkg = { version: typeof __VERSION__ !== 'undefined' ? __VERSION__ : require('../package.json').version };

// 子进程 stdio 模式下，未捕获的 rejection 会导致进程静默退出；打到 stderr 便于 MCP 客户端侧排查 Connection closed
process.on('unhandledRejection', (reason, promise) => {
  console.error('[roxybrowser-playwright-mcp] unhandledRejection:', reason);
});

program
  .name('roxybrowser-mcp-server-playwright')
  .description('Playwright MCP server with RoxyBrowser custom tools')
  .version(pkg.version)
  // Commander v13+ 默认不允许多余参数；MCP 客户端可能传入 server 名等，允许以免进程直接退出导致 Connection closed
  .allowExcessArguments(true);

decorateCommand(program, pkg.version);

program.action(async (options) => {
  if (options.vision) {
    console.error('The --vision option is deprecated, use --caps=vision instead');
    options.caps = 'vision';
  }
  const config = await resolveCLIConfig(options);
  const browserContextFactory = contextFactory(config);
  const createServer = () => createMcpServer({
    name: 'Playwright+Roxy',
    version: pkg.version,
    createBackend: () => new CustomBackend(config, browserContextFactory),
    runHeartbeat: options.port !== undefined,
  });

  if (config.server?.port === undefined) {
    await connectStdio(createServer);
    return;
  }

  const result = await startHttpTransport(createServer, {
    host: config.server.host,
    port: config.server.port,
    allowedHosts: options.allowedHosts,
  });
  console.error([
    `Listening on ${result.baseUrl}`,
    'Put this in your client config:',
    JSON.stringify({
      mcpServers: {
        playwright: {
          url: result.url,
        },
      },
    }, null, 2),
    `Legacy SSE endpoint: ${result.baseUrl}${result.ssePath}`,
  ].join('\n'));
});

// 必须用 parseAsync 并 await，否则 async action 未跑完进程就退出，导致 MCP 客户端报 Connection closed
await program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});
