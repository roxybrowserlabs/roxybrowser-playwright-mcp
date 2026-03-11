#!/usr/bin/env node
/**
 * Roxybrowser Playwright MCP Server（方案一：CustomBackend 包装官方 backend + 自定义工具）
 *
 * 使用 pnpm patch 暴露的 playwright MCP 模块；CLI 沿用官方选项，backend 替换为 CustomBackend。
 */
import { createRequire } from 'node:module';
import { CustomBackend } from './customBackend.js';
import { decorateCommand } from 'playwright/lib/mcp/program';
import { start } from 'playwright/lib/mcp/sdk/exports';
import { resolveCLIConfig } from 'playwright/lib/mcp/browser/config';
import { contextFactory } from 'playwright/lib/mcp/browser/browserContextFactory';
import { program } from 'commander';

const require = createRequire(import.meta.url);
const pkg = { version: typeof __VERSION__ !== 'undefined' ? __VERSION__ : require('../package.json').version };

program
  .name('roxybrowser-mcp-server-playwright')
  .description('Playwright MCP server with RoxyBrowser custom tools')
  .version(pkg.version);

decorateCommand(program, pkg.version);

program.action(async (options) => {
  if (options.vision) {
    console.error('The --vision option is deprecated, use --caps=vision instead');
    options.caps = 'vision';
  }
  const config = await resolveCLIConfig(options);
  const browserContextFactory = contextFactory(config);

  const serverBackendFactory = {
    name: 'Playwright+Roxy',
    nameInConfig: 'playwright',
    version: pkg.version,
    create: () => new CustomBackend(config, browserContextFactory),
  };

  await start(serverBackendFactory, config.server);
});

program.parse();
