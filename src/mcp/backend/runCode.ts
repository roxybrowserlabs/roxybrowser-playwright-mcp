import { readFile } from "node:fs/promises";
import { z } from "zod";
import { defineTool } from "./tool.js";

const codeSchema = z.object({
  code: z.string().optional().describe("A JavaScript function containing Playwright code to execute. It will be invoked with a single argument, page, which you can use for any page interaction."),
  filename: z.string().optional().describe("Load code from the specified file. If both code and filename are provided, code will be ignored.")
});

const runCode = defineTool({
  capability: "devtools",
  schema: {
    name: "browser_run_code_unsafe",
    title: "Run code (unsafe)",
    description: "Run arbitrary code against the current browser session.",
    inputSchema: codeSchema,
    type: "action"
  },
  handle: async (context, args, response) => {
    let code = args.code;
    if (args.filename) {
      code = await readFile(args.filename, "utf8");
    }
    if (code === undefined) {
      throw new Error("Either code or filename is required.");
    }
    const result = await context.runtime.runCodeUnsafe(code);
    response.addTextResult(JSON.stringify(result, null, 2) ?? "undefined");
  }
});

export default [runCode];
