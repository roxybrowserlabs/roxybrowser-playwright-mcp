import { DynamicCdpContextFactory } from './DynamicCdpContextFactory.js';

/** 是否已通过工具 browser_connect_roxy 写入 CDP 并处于可会话状态 */
export function isBrowserSessionReadyForTools(context) {
  if (!context) return false;
  const f = context._browserContextFactory;
  return f instanceof DynamicCdpContextFactory && Boolean(f._currentCdpEndpoint);
}

export function notConnectedToolResult(toolName) {
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
          `2. After a successful connection, call the tool you need: \`${toolName}\``,
        ].join('\n'),
      },
    ],
    isError: false,
  };
}
