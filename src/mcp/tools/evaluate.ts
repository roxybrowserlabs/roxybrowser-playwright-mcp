import { writeFile } from "node:fs/promises";
import { z } from "zod";
import { defineTool, textResult } from "../tool.js";

const evaluate = defineTool({
  schema: {
    name: "browser_evaluate",
    title: "Evaluate JavaScript",
    description: "Evaluate JavaScript expression on page or element",
    inputSchema: z.object({
      element: z.string().optional().describe("Human-readable element description used to obtain permission to interact with the element"),
      target: z.string().optional().describe("Exact target element reference from the page snapshot, or a unique element selector"),
      function: z.string().describe("() => { /* code */ } or (element) => { /* code */ } when element is provided"),
      filename: z.string().optional().describe("Filename to save the result to. If not provided, result is returned as text.")
    })
  },
  handle: async (args, runtime) => {
    const result = await runtime.evaluate(args.function, args.target);
    const text = JSON.stringify(result, null, 2) ?? "undefined";
    if (args.filename) {
      await writeFile(args.filename, text);
      return textResult(`Saved evaluation result to "${args.filename}".`);
    }
    return textResult(text);
  }
});

export default [evaluate];
