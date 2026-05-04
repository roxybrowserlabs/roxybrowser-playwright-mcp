import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

// 工具辅助函数
export function defineExtraTool(schema, handle) {
  return { schema, handle };
}

export function extraToolToMcp(schema) {
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
