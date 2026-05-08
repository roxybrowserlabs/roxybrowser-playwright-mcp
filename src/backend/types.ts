export type ToolContext = import('playwright/lib/mcp/browserServerBackend').ToolContext;
export type ToolResult = import('playwright/lib/mcp/browserServerBackend').ToolResult;
export type McpTool = import('@modelcontextprotocol/sdk/types.js').Tool;

export type ToolDefinition<TArgs = any> = {
  schema: {
    name: string;
    title: string;
    description: string;
    inputSchema: import('zod').ZodType<TArgs>;
    type?: 'action' | 'readOnly' | 'destructive' | 'input';
  };
  handle: (
    context: ToolContext,
    args: TArgs,
    progress?: unknown
  ) => Promise<ToolResult>;
};
