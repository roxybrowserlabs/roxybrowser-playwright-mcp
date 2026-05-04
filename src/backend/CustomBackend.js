import { BrowserServerBackend } from 'playwright/lib/mcp/browserServerBackend';
import { extraToolToMcp } from './helpers.js';
import { isBrowserSessionReadyForTools, notConnectedToolResult } from './utils.js';
import { BROWSER_CONNECT_ROXY, BROWSER_CLICK } from '../tools/index.js';

/** 从 Playwright 官方 MCP 中排除的工具名 */
const EXCLUDED_PLAYWRIGHT_TOOL_NAMES = new Set(['browser_install', 'browser_close', 'browser_click']);

export class CustomBackend extends BrowserServerBackend {
  constructor(config, factory) {
    super(config, factory);
    this._extraTools = [BROWSER_CONNECT_ROXY, BROWSER_CLICK];
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
