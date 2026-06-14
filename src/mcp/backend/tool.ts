import type { z } from "zod";
import type { CallToolResult, Tool as McpToolDefinition } from "@modelcontextprotocol/sdk/types.js";
import type { Context } from "./context.js";
import type { Tab } from "./tab.js";
import type { Response } from "./response.js";

type AnyZodObject = z.ZodObject<z.ZodRawShape>;

type ToolSchema<Input extends AnyZodObject> = {
  name: string;
  title: string;
  description: string;
  inputSchema: Input;
  listedInputSchema?: McpToolDefinition["inputSchema"];
  type: "input" | "assertion" | "action" | "readOnly";
};

export type ToolCapability =
  | "config"
  | "core"
  | "core-navigation"
  | "core-tabs"
  | "core-input"
  | "core-install"
  | "network"
  | "pdf"
  | "storage"
  | "testing"
  | "vision"
  | "devtools";

export type FileUploadModalState = {
  type: "fileChooser";
  description: string;
  clearedBy: { tool: string; skill: string };
};

export type DialogModalState = {
  type: "dialog";
  description: string;
  clearedBy: { tool: string; skill: string };
};

export type ModalState = FileUploadModalState | DialogModalState;

export type Tool<Input extends AnyZodObject = AnyZodObject> = {
  capability: ToolCapability;
  skillOnly?: boolean;
  schema: ToolSchema<Input>;
  handle: (
    context: Context,
    params: z.output<Input>,
    response: Response,
    signal?: AbortSignal
  ) => Promise<void>;
};

export function defineTool<Input extends AnyZodObject>(tool: Tool<Input>): Tool<Input> {
  return tool;
}

export type TabTool<Input extends AnyZodObject = AnyZodObject> = {
  capability: ToolCapability;
  skillOnly?: boolean;
  schema: ToolSchema<Input>;
  clearsModalState?: ModalState["type"];
  handle: (
    tab: Tab,
    params: z.output<Input>,
    response: Response,
    signal?: AbortSignal
  ) => Promise<void>;
};

export function defineTabTool<Input extends AnyZodObject>(tool: TabTool<Input>): Tool<Input> {
  return {
    ...tool,
    handle: async (context, params, response, signal) => {
      const tab = await context.ensureTab();
      const modalStates = tab.modalStates().map((state) => state.type);
      if (tool.clearsModalState && !modalStates.includes(tool.clearsModalState)) {
        response.addError(missingModalStateMessage(tool));
      } else if (!tool.clearsModalState && modalStates.length) {
        response.addError(`Error: Tool "${tool.schema.name}" does not handle the modal state.`);
      } else {
        await tool.handle(tab, params, response, signal);
      }
    }
  };
}

function missingModalStateMessage(tool: TabTool<AnyZodObject>): string {
  if (tool.clearsModalState === "fileChooser") {
    return "[no_file_chooser] No file chooser visible.";
  }
  return `Error: The tool "${tool.schema.name}" can only be used when there is related modal state present.`;
}

export type SerializedToolResult = CallToolResult & { isClose?: boolean };
