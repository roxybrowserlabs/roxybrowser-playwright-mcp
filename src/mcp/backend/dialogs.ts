import { z } from "zod";
import { defineTool } from "./tool.js";

const handleDialog = defineTool({
  capability: "core",
  schema: {
    name: "browser_handle_dialog",
    title: "Handle a dialog",
    description: "Handle a dialog",
    inputSchema: z.object({
      accept: z.boolean().describe("Whether to accept the dialog."),
      promptText: z.string().optional().describe("The text of the prompt in case of a prompt dialog.")
    }),
    type: "action"
  },
  handle: async (context, params, response) => {
    const snapshot = await context.runtime.handleDialog(params.accept, params.promptText);
    response.setIncludeSnapshot();
    if (!snapshot) {
      response.addTextResult(params.accept ? "Accepted dialog." : "Dismissed dialog.");
    }
  }
});

export default [handleDialog];
