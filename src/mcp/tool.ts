import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpRuntime } from "./runtime.js";

// Bound on ZodObject so `.shape` is available at registration time.
type AnyZodObject = z.ZodObject<z.ZodRawShape>;

export type ToolSchema<Input extends AnyZodObject = AnyZodObject> = {
  name: string;
  title: string;
  description: string;
  inputSchema: Input;
};

export type Tool<Input extends AnyZodObject = AnyZodObject> = {
  schema: ToolSchema<Input>;
  handle: (args: z.output<Input>, runtime: McpRuntime) => Promise<CallToolResult>;
};

export function defineTool<Input extends AnyZodObject>(tool: Tool<Input>): Tool {
  return tool as unknown as Tool;
}

export function textResult(text: string, isError = false): CallToolResult {
  return {
    content: [{ type: "text", text }],
    ...(isError ? { isError: true } : {})
  };
}
