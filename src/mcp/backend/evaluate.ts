import { writeFile } from "node:fs/promises";
import { z } from "zod";
import { optionalElementSchema } from "./snapshot.js";
import { defineTabTool } from "./tool.js";
import { escapeWithQuotes } from "./utils.js";

const evaluateSchema = optionalElementSchema.extend({
  function: z.string().describe("() => { /* code */ } or (element) => { /* code */ } when element is provided"),
  filename: z.string().optional().describe("Filename to save the result to. If not provided, result is returned as text.")
});

const evaluate = defineTabTool({
  capability: "core",
  schema: {
    name: "browser_evaluate",
    title: "Evaluate JavaScript",
    description: "Evaluate JavaScript expression on page or element",
    inputSchema: evaluateSchema,
    type: "action"
  },
  handle: async (tab, params, response) => {
    let locator: Awaited<ReturnType<typeof tab.targetLocator>> | undefined;
    const expression = params.function;
    if (params.target) {
      locator = await tab.targetLocator({ target: params.target, element: params.element || "element" });
    }

    await tab.waitForCompletion(async () => {
      const evalResult = locator?.locator
        ? await locator.locator.evaluate(expression)
        : await tab.context.runtime.evaluate(expression);

      const codeExpression = evalResult.isFunction ? expression : `() => (${expression})`;
      if (locator) {
        response.addCode(`await page.${locator.resolved}.evaluate(${escapeWithQuotes(codeExpression)});`);
      } else {
        response.addCode(`await page.evaluate(${escapeWithQuotes(codeExpression)});`);
      }

      const text = JSON.stringify(evalResult.result, null, 2) ?? "undefined";
      if (params.filename) {
        const resolvedFilename = await tab.context.resolveOutputFile(params.filename, "script");
        await writeFile(resolvedFilename, text);
        response.addTextResult(`- [Evaluation result](${resolvedFilename})`);
        return;
      }
      response.addTextResult(text);
    }).catch((error) => {
      response.addError(error instanceof Error ? error.message : String(error));
    });
  }
});

export default [evaluate];
