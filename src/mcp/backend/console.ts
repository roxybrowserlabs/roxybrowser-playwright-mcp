import { writeFile } from "node:fs/promises";
import { z } from "zod";
import { defineTool } from "./tool.js";

const consoleMessages = defineTool({
  capability: "core",
  schema: {
    name: "browser_console_messages",
    title: "Get console messages",
    description: "Returns all console messages",
    inputSchema: z.object({
      level: z.enum(["error", "warning", "info", "debug"]).default("info").describe('Level of the console messages to return. Each level includes the messages of more severe levels. Defaults to "info".'),
      all: z.boolean().optional().describe("Return all console messages since the beginning of the session, not just since the last navigation. Defaults to false."),
      filename: z.string().optional().describe("Filename to save the console messages to. If not provided, messages are returned as text.")
    }),
    type: "readOnly"
  },
  handle: async (context, params, response) => {
    const messages = await context.runtime.consoleMessages(params.level, params.all);
    const errors = messages.filter((message) => message.type === "error" || message.type === "assert").length;
    const warnings = messages.filter((message) => message.type === "warning").length;
    const text = [
      `Total messages: ${messages.length} (Errors: ${errors}, Warnings: ${warnings})`,
      "",
      ...messages.map((message) => message.formattedText)
    ].join("\n");
    if (params.filename) {
      const resolvedFilename = await context.resolveOutputFile(params.filename);
      await writeFile(resolvedFilename, text);
      response.addTextResult(`Saved console messages to "${resolvedFilename}".`);
      return;
    }
    response.addTextResult(text);
  }
});

export default [consoleMessages];
