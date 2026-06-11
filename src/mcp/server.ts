import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { isMcpToolError } from "./errors.js";
import { textResult } from "./tool.js";
import { allTools } from "./tools/index.js";
import { McpRuntimeManager } from "./runtime.js";
import type {
  CreateRoxyBrowserMcpServerOptions,
  RoxyBrowserMcpServerBundle
} from "./types.js";

function toolErrorResult(error: unknown): CallToolResult {
  if (isMcpToolError(error)) {
    return textResult(`[${error.code}] ${error.message}`, true);
  }

  const message = error instanceof Error ? error.message : String(error);
  return textResult(message, true);
}

export function createRoxyBrowserMcpServer(
  options: CreateRoxyBrowserMcpServerOptions = {}
): RoxyBrowserMcpServerBundle {
  const runtimeManager = new McpRuntimeManager(options.sessionFactory, {
    ...(options.snapshotMode !== undefined ? { snapshotMode: options.snapshotMode } : {})
  });
  const server = new McpServer({
    name: options.serverInfo?.name ?? "roxybrowser-mcp",
    version: options.serverInfo?.version ?? "0.1.0"
  });

  for (const tool of allTools) {
    server.registerTool(
      tool.schema.name,
      {
        title: tool.schema.title,
        description: tool.schema.description,
        inputSchema: tool.schema.inputSchema.shape
      },
      async (args, extra) => {
        try {
          const runtime = runtimeManager.getRuntime(extra.sessionId);
          return await tool.handle(args, runtime);
        } catch (error) {
          return toolErrorResult(error);
        }
      }
    );
  }

  return {
    server,
    runtimeManager,
    close: async () => {
      await runtimeManager.closeAll();
      if (server.isConnected()) {
        await server.close();
      }
    }
  };
}
