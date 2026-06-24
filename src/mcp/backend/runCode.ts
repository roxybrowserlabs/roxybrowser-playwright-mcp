import { z } from "zod";
import { defineTool } from "./tool.js";

const runCode = defineTool({
  capability: "devtools",
  schema: {
    name: "browser_run_code_unsafe",
    title: "Run code (unsafe)",
    description: "Run arbitrary code against the current browser session.",
    inputSchema: z.object({
      code: z.string().describe("JavaScript code to run against the browser session.")
    }),
    type: "action"
  },
  handle: async (context, args, response) => {
    const result = await context.runtime.runCodeUnsafe(args.code);
    response.addTextResult(JSON.stringify(result, null, 2) ?? "undefined");
  }
});

export default [runCode];
