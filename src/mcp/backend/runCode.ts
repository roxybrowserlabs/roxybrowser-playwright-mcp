import { readFile } from "node:fs/promises";
import { z } from "zod";
import { defineTool } from "./tool.js";

const codeSchema = z.object({
  code: z.string().optional().describe("A JavaScript function containing Playwright code to execute. It will be invoked with a single argument, page, which you can use for any page interaction. For example: `async (page) => { await page.getByRole('button', { name: 'Submit' }).click(); return await page.title(); }`"),
  filename: z.string().optional().describe("Load code from the specified file. If both code and filename are provided, code will be ignored.")
});

const runCode = defineTool({
  capability: "core",
  schema: {
    name: "browser_run_code_unsafe",
    title: "Run Playwright code (unsafe)",
    description: "Run a Playwright code snippet. Unsafe: executes arbitrary JavaScript in the Playwright server process and is RCE-equivalent.",
    inputSchema: codeSchema,
    type: "action"
  },
  handle: async (context, args, response) => {
    let code = args.code;
    if (args.filename) {
      code = await readFile(await response.resolveClientFilename(args.filename), "utf8");
    }
    response.addCode(`await (${code})(page);`);
    const result = await context.runtime.runCodeUnsafe(code);
    if (typeof result === "string") {
      response.addTextResult(result);
    }
  }
});

export default [runCode];
