import { writeFile } from "node:fs/promises";
import { z } from "zod";
import { defineTool } from "./tool.js";

const evaluate = defineTool({
  capability: "core",
  schema: {
    name: "browser_evaluate",
    title: "Evaluate JavaScript",
    description: "Evaluate JavaScript expression on page or element",
    inputSchema: z.object({
      element: z.string().optional().describe("Human-readable element description used to obtain permission to interact with the element"),
      target: z.string().optional().describe("Exact target element reference from the page snapshot, or a unique element selector"),
      function: z.string().describe("() => { /* code */ } or (element) => { /* code */ } when element is provided"),
      filename: z.string().optional().describe("Filename to save the result to. If not provided, result is returned as text.")
    }),
    type: "action"
  },
  handle: async (context, params, response) => {
    const result = await context.runtime.evaluate(params.function, params.target);
    const text = JSON.stringify(result, null, 2) ?? "undefined";
    if (params.filename) {
      const resolvedFilename = await context.resolveOutputFile(params.filename, "script");
      await writeFile(resolvedFilename, text);
      response.addTextResult(`Saved evaluation result to "${resolvedFilename}".`);
      return;
    }
    response.addTextResult(text);
  }
});

export default [evaluate];
