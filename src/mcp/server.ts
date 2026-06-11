import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ListToolsRequestSchema,
  type CallToolResult,
  type ListToolsResult,
  type Tool as McpToolDefinition
} from "@modelcontextprotocol/sdk/types.js";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
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
  registerListedToolSchemaOverrides(server);

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

function registerListedToolSchemaOverrides(server: McpServer): void {
  const listedInputSchemas = new Map(
    allTools
      .filter((tool) => tool.schema.listedInputSchema)
      .map((tool) => [tool.schema.name, tool.schema.listedInputSchema!])
  );

  if (listedInputSchemas.size === 0) {
    return;
  }

  const toolDefinitions = allTools.map<McpToolDefinition>((tool) => ({
    name: tool.schema.name,
    title: tool.schema.title,
    description: tool.schema.description,
    inputSchema: listedInputSchemas.get(tool.schema.name)
      ?? objectInputSchema(toJsonSchemaCompat(tool.schema.inputSchema, {
        strictUnions: true,
        pipeStrategy: "input"
      }))
  }));

  server.server.setRequestHandler(ListToolsRequestSchema, (): ListToolsResult => ({
    tools: toolDefinitions
  }));
}

function objectInputSchema(schema: unknown): McpToolDefinition["inputSchema"] {
  if (isRecord(schema) && schema.type === "object") {
    return schema as McpToolDefinition["inputSchema"];
  }

  throw new Error("MCP tool input schema must be a JSON object schema.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
