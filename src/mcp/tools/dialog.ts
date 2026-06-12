import { z } from "zod";
import { defineTool, textResult } from "../tool.js";
import { formatSnapshot } from "../format.js";

const handleDialog = defineTool({
  schema: {
    name: "browser_handle_dialog",
    title: "Handle a dialog",
    description: "Handle a dialog",
    inputSchema: z.object({
      accept: z.boolean().describe("Whether to accept the dialog."),
      promptText: z.string().optional().describe("The text of the prompt in case of a prompt dialog.")
    })
  },
  handle: async (args, runtime) => {
    const snap = await runtime.handleDialog(args.accept, args.promptText);
    if (!snap) return textResult(args.accept ? "Accepted dialog." : "Dismissed dialog.");
    return textResult(formatSnapshot(snap));
  }
});

export default [handleDialog];
