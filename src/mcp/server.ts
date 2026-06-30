import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ListToolsRequestSchema,
  type CallToolResult,
  type ListToolsResult,
  type Tool as McpToolDefinition
} from "@modelcontextprotocol/sdk/types.js";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import { Context } from "./backend/context.js";
import { Response } from "./backend/response.js";
import { browserTools as allBackendTools } from "./backend/tools.js";
import type { Tool as BackendTool } from "./backend/tool.js";
import { isMcpToolError } from "./errors.js";
import { textResult, type Tool as LegacyTool } from "./tool.js";
import { allTools } from "./tools/index.js";
import { McpRuntimeManager } from "./runtime.js";
import type {
  CreateRoxyBrowserMcpServerOptions,
  RoxyBrowserMcpServerBundle
} from "./types.js";

type RegisteredTool = LegacyTool | BackendTool;

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
    ...(options.snapshotMode !== undefined ? { snapshotMode: options.snapshotMode } : {}),
    ...(options.outputDir !== undefined ? { outputDir: options.outputDir } : {}),
    ...(options.tempDir !== undefined ? { tempDir: options.tempDir } : {})
  });
  const server = new McpServer({
    name: options.serverInfo?.name ?? "roxybrowser-mcp",
    version: options.serverInfo?.version ?? "0.1.0"
  });
  const backendToolNames = new Set(allBackendTools.map((tool) => tool.schema.name));
  const legacyTools = allTools.filter((tool) => !backendToolNames.has(tool.schema.name));
  const registeredTools: RegisteredTool[] = [...legacyTools, ...allBackendTools];
  let lastSessionId: string | undefined;

  for (const tool of legacyTools) {
    server.registerTool(
      tool.schema.name,
      {
        title: tool.schema.title,
        description: tool.schema.description,
        inputSchema: tool.schema.inputSchema.shape
      },
      async (args, extra) => {
        try {
          lastSessionId = extra.sessionId;
          const runtime = runtimeManager.getRuntime(extra.sessionId);
          return await tool.handle(args, runtime);
        } catch (error) {
          return toolErrorResult(error);
        }
      }
    );
  }

  for (const tool of allBackendTools) {
    server.registerTool(
      tool.schema.name,
      {
        title: tool.schema.title,
        description: tool.schema.description,
        inputSchema: tool.schema.inputSchema.shape
      },
      async (args, extra) => {
        try {
          lastSessionId = extra.sessionId;
          const runtime = runtimeManager.getRuntime(extra.sessionId);
          const context = new Context(runtime, {
            ...(options.outputDir !== undefined ? { outputDir: options.outputDir } : {}),
            ...(options.tempDir !== undefined ? { tempDir: options.tempDir } : {}),
            ...(options.snapshotMode !== undefined
              ? {
                  snapshot: {
                    mode: options.snapshotMode
                  }
                }
              : {})
          });
          const response = new Response(context, tool.schema.name, args);
          await tool.handle(context, args, response);
          return await response.serialize();
        } catch (error) {
          return toolErrorResult(error);
        }
      }
    );
  }

  registerListedToolSchemaOverrides(server, registeredTools);

  return {
    server,
    runtimeManager,
    getLastSessionId: () => lastSessionId,
    close: async () => {
      await runtimeManager.closeAll();
      if (server.isConnected()) {
        await server.close();
      }
    }
  };
}

function registerListedToolSchemaOverrides(server: McpServer, tools: RegisteredTool[]): void {
  const listedInputSchemas = new Map(
    tools
      .filter((tool) => hasListedInputSchema(tool))
      .map((tool) => [tool.schema.name, tool.schema.listedInputSchema!])
  );

  if (listedInputSchemas.size === 0) {
    return;
  }

  const toolDefinitions = tools.map<McpToolDefinition>((tool) => ({
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

function hasListedInputSchema(tool: RegisteredTool): tool is LegacyTool {
  return "listedInputSchema" in tool.schema;
}
