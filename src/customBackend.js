/**
 * CustomBackend：在 Playwright 官方 BrowserServerBackend 基础上增加自定义工具。
 * 连接 RoxyBrowser 的逻辑与 src/tools/roxy.ts + src/browserContextFactory.ts (DynamicCdpContextFactory) 一致。
 */
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import playwright from 'playwright-core';
import { BrowserServerBackend } from 'playwright/lib/mcp/browserServerBackend';

/** 与 src/browserContextFactory.ts 中 DynamicCdpContextFactory 行为一致：支持 reconnectToCDP，后续 createContext 连到该 CDP */
class DynamicCdpContextFactory {
  constructor(config, initialCdpEndpoint = undefined) {
    this.config = config;
    this._currentCdpEndpoint = initialCdpEndpoint;
    this._browserPromise = undefined;
  }

  reconnectToCDP(cdpEndpoint) {
    if (this._currentCdpEndpoint === cdpEndpoint && this._browserPromise) return;
    this._currentCdpEndpoint = cdpEndpoint;
    this._browserPromise = undefined;
  }

  async createContext(clientInfo, _abortSignal, options = {}) {
    const endpoint = this._currentCdpEndpoint;
    if (!endpoint) {
      throw new Error(
        'No CDP endpoint set. Use the browser_connect_roxy tool to connect to RoxyBrowser first. ' +
          'Example: {"name": "browser_connect_roxy", "arguments": {"cdpEndpoint": "ws://127.0.0.1:PORT/devtools/browser/ID"}}'
      );
    }
    if (!this._browserPromise) {
      this._browserPromise = playwright.chromium.connectOverCDP(endpoint, { timeout: 30000 });
      this._browserPromise.catch(() => {
        this._browserPromise = undefined;
      });
    }
    const browser = await this._browserPromise;
    const browserContext = this.config.browser?.isolated
      ? await browser.newContext()
      : (browser.contexts().length ? browser.contexts()[0] : await browser.newContext());

    const close = async () => {
      await browserContext.close().catch(() => {});
      if (browser.contexts().length === 0) await browser.close().catch(() => {});
    };
    return { browserContext, close };
  }
}

function defineExtraTool(schema, handle) {
  return { schema, handle };
}

function extraToolToMcp(schema) {
  return {
    name: schema.name,
    description: schema.description,
    inputSchema: zodToJsonSchema(schema.inputSchema, { strictUnions: true }),
    annotations: {
      title: schema.title,
      readOnlyHint: schema.type === 'readOnly',
      destructiveHint: schema.type === 'destructive',
      openWorldHint: true,
    },
  };
}

/** 是否已通过工具 browser_connect_roxy 写入 CDP 并处于可会话状态 */
export function isBrowserSessionReadyForTools(context) {
  if (!context) return false;
  const f = context._browserContextFactory;
  return f instanceof DynamicCdpContextFactory && Boolean(f._currentCdpEndpoint);
}

/** 从 Playwright 官方 MCP 中排除的工具名（例如 RoxyBrowser 由外部提供浏览器，无需 browser_install）。 */
const EXCLUDED_PLAYWRIGHT_TOOL_NAMES = new Set(['browser_install', 'browser_close']);

function notConnectedToolResult(toolName) {
  return {
    content: [
      {
        type: 'text',
        text: [
          '### Browser not connected',
          '',
          'This MCP server is not connected to a browser over CDP yet (e.g. RoxyBrowser / RoxyChrome). Get the **CDP WebSocket URL** from the browser, then:',
          '',
          '1. Call the `browser_connect_roxy` tool with `cdpEndpoint` set to that URL (example: `ws://127.0.0.1:59305/devtools/browser/...`).',
          `2. After a successful connection, call the tool you need: \`${toolName}\`.`,
        ].join('\n'),
      },
    ],
    isError: false,
  };
}

const BROWSER_CONNECT_ROXY = defineExtraTool(
  {
    name: 'browser_connect_roxy',
    title: 'Connect to RoxyBrowser',
    description:
      'Connect to RoxyBrowser using CDP WebSocket endpoint (e.g. from RoxyChrome).',
    inputSchema: z.object({
      cdpEndpoint: z
        .string()
        .describe(
          'CDP WebSocket URL from RoxyBrowser, e.g. ws://127.0.0.1:59305/devtools/browser/...'
        ),
    }),
    type: 'destructive',
  },
  async (context, args) => {
    const { cdpEndpoint } = args;
    await context.closeBrowserContext();
    const factory = new DynamicCdpContextFactory(context.config, cdpEndpoint);
    context._browserContextFactory = factory;
    await context.ensureTab();
    return {
      content: [
        {
          type: 'text',
          text: `### Result\nSuccessfully connected to RoxyBrowser at ${cdpEndpoint}\nSubsequent browser actions will run in this window.`,
        },
      ],
    };
  }
);

export {
  DynamicCdpContextFactory,
  defineExtraTool,
  extraToolToMcp,
};

export class CustomBackend extends BrowserServerBackend {
  constructor(config, factory) {
    super(config, factory);
    this._extraTools = [BROWSER_CONNECT_ROXY];
  }

  async listTools() {
    const baseTools = (await super.listTools()).filter(
      (t) => !EXCLUDED_PLAYWRIGHT_TOOL_NAMES.has(t.name)
    );
    const extraMcp = this._extraTools.map((t) => extraToolToMcp(t.schema));
    return [...baseTools, ...extraMcp];
  }

  async callTool(name, rawArguments, progress) {
    const extra = this._extraTools.find((t) => t.schema.name === name);
    if (extra) {
      try {
        const parsed = extra.schema.inputSchema.parse(rawArguments || {});
        return await extra.handle(this._context, parsed, progress);
      } catch (err) {
        return {
          content: [{ type: 'text', text: `### Error\n${String(err)}` }],
          isError: false,
        };
      }
    }
    if (EXCLUDED_PLAYWRIGHT_TOOL_NAMES.has(name)) {
      return {
        content: [
          {
            type: 'text',
            text: [
              '### Tool unavailable',
              '',
              `The tool \`${name}\` is not exposed by this MCP server (browser is provided externally; use RoxyBrowser / CDP connection instead).`,
            ].join('\n'),
          },
        ],
        isError: true,
      };
    }
    if (!isBrowserSessionReadyForTools(this._context))
      return notConnectedToolResult(name);
    const result = await super.callTool(name, rawArguments, progress);
    // 工具执行错误（如超时、元素被遮挡）时，不设 isError，让客户端把结果当正常返回交给 LLM，
    // 这样 agent 可以总结错误信息再回复用户，而不是被客户端直接中断。
    if (result && result.isError && result.content) {
      return { ...result, isError: false };
    }
    return result;
  }
}
