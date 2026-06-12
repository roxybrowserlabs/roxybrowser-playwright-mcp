import { readFile } from "node:fs/promises";
import { z } from "zod";
import { defineTool, textResult } from "../tool.js";

const runCode = defineTool({
  schema: {
    name: "browser_run_code_unsafe",
    title: "Run Playwright code (unsafe)",
    description: "Run a Playwright code snippet. Unsafe: executes arbitrary JavaScript in the browser context approximation and is RCE-equivalent in intent.",
    inputSchema: z.object({
      code: z.string().optional().describe("A JavaScript function containing Playwright-like code to execute."),
      filename: z.string().optional().describe("Load code from the specified file. If both code and filename are provided, code will be ignored.")
    })
  },
  handle: async (args, runtime) => {
    const code = args.filename ? await readFile(args.filename, "utf8") : args.code;
    if (!code) {
      throw new Error("Either code or filename must be provided.");
    }
    const result = await runtime.runCodeUnsafe(code);
    return textResult(JSON.stringify(result, null, 2) ?? "undefined");
  }
});

export default [runCode];
