import { DynamicCdpContextFactory } from './DynamicCdpContextFactory.js';
import type { ToolContext, ToolResult } from './types.js';

/** 是否已通过工具 browser_connect_roxy 写入 CDP 并处于可会话状态 */
export function isBrowserSessionReadyForTools(context: ToolContext | undefined): boolean {
  if (!context) return false;
  const f = context._browserContextFactory;
  return f instanceof DynamicCdpContextFactory && Boolean(f._currentCdpEndpoint);
}

export function notConnectedToolResult(toolName: string): ToolResult {
  return {
    content: [
      {
        type: 'text',
        text: [
          '### Browser not connected',
          '',
          'This MCP server is not connected to a browser yet. You need a **WebSocket URL** from your browser service:',
          '',
          '- **For Chrome**: use a CDP WebSocket URL like `ws://127.0.0.1:59305/devtools/browser/...`',
          '- **For Firefox**: use a BiDi WebSocket endpoint',
          '',
          '1. Call the `browser_connect_roxy` tool with `endpoint` set to that URL and optionally specify `browserCore` ("Chrome" or "Firefox").',
          `2. After a successful connection, call the tool you need: \`${toolName}\``,
        ].join('\n'),
      },
    ],
    isError: false,
  };
}
