import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { McpTool, ToolDefinition } from './types.js';

// 工具辅助函数
export function defineExtraTool<TArgs>(schema: ToolDefinition<TArgs>['schema'], handle: ToolDefinition<TArgs>['handle']): ToolDefinition<TArgs> {
  return { schema, handle };
}

export function extraToolToMcp(schema: ToolDefinition['schema']): McpTool {
  const inputSchema = zodToJsonSchema(schema.inputSchema, { strictUnions: true }) as McpTool['inputSchema'];
  return {
    name: schema.name,
    description: schema.description,
    inputSchema,
    annotations: {
      title: schema.title,
      readOnlyHint: schema.type === 'readOnly',
      destructiveHint: schema.type === 'destructive',
      openWorldHint: true,
    },
  };
}
