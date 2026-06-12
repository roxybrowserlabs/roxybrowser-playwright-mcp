import { z } from "zod";
import { defineTool, textResult } from "../tool.js";
import { formatSnapshot } from "../format.js";

const navigate = defineTool({
  schema: {
    name: "browser_navigate",
    title: "Navigate to a URL",
    description: "Navigate to a URL",
    inputSchema: z.object({
      url: z.string().describe("The URL to navigate to")
    })
  },
  handle: async (args, runtime) => {
    const snap = await runtime.navigate(args.url);
    if (!snap) return textResult(`Navigated to "${args.url}".`);
    return textResult(formatSnapshot(snap));
  }
});

const goBack = defineTool({
  schema: {
    name: "browser_navigate_back",
    title: "Go back",
    description: "Go back to the previous page in the history",
    inputSchema: z.object({})
  },
  handle: async (_args, runtime) => {
    const snap = await runtime.goBack();
    if (!snap) return textResult("Navigated back.");
    return textResult(formatSnapshot(snap));
  }
});

const goForward = defineTool({
  schema: {
    name: "browser_navigate_forward",
    title: "Go forward",
    description: "Go forward to the next page in the history",
    inputSchema: z.object({})
  },
  handle: async (_args, runtime) => {
    const snap = await runtime.goForward();
    if (!snap) return textResult("Navigated forward.");
    return textResult(formatSnapshot(snap));
  }
});

const waitFor = defineTool({
  schema: {
    name: "browser_wait_for",
    title: "Wait for",
    description: "Wait for text to appear or disappear or a specified time to pass",
    inputSchema: z.object({
      time: z.number().optional().describe("The time to wait in seconds"),
      text: z.string().optional().describe("The text to wait for"),
      textGone: z.string().optional().describe("The text to wait for to disappear")
    })
  },
  handle: async (args, runtime) => {
    if (!args.text && !args.textGone && !args.time) {
      throw new Error("Either time, text or textGone must be provided");
    }
    if (args.time) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(30_000, args.time! * 1000)));
    }
    const snap = await runtime.waitFor(
      {
        ...(args.text !== undefined ? { text: args.text } : {}),
        ...(args.textGone !== undefined ? { textGone: args.textGone } : {})
      },
      5000
    );
    return textResult(formatSnapshot(snap));
  }
});

export default [navigate, goBack, goForward, waitFor];
