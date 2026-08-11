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
    const count = await context.runtime.consoleMessageSummary();
    const header = [`Total messages: ${count.total} (Errors: ${count.errors}, Warnings: ${count.warnings})`];
    const messages = await context.runtime.consoleMessages(params.level, params.all);
    if (messages.length !== count.total) {
      header.push(`Returning ${messages.length} messages for level "${params.level}"`);
    }
    const text = [...header, "", ...messages.map((message) => message.formattedText)].join("\n");
    if (params.filename) {
      const resolvedFilename = await context.resolveOutputFile(params.filename, "console");
      await context.writeTextFile(resolvedFilename, text);
      response.addTextResult(`Saved console messages to "${resolvedFilename}".`);
      return;
    }
    response.addTextResult(text);
  }
});

const consoleClear = defineTool({
  capability: "core",
  skillOnly: true,
  schema: {
    name: "browser_console_clear",
    title: "Clear console messages",
    description: "Clear all console messages",
    inputSchema: z.object({}),
    type: "readOnly"
  },
  handle: async (context) => {
    await context.runtime.clearConsoleMessages();
  }
});

export default [consoleMessages, consoleClear];
