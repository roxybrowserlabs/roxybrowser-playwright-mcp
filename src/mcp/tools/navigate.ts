import { z } from "zod";
import { defineTool, textResult } from "../tool.js";
import { formatSnapshot } from "../format.js";

const navigate = defineTool({
  schema: {
    name: "browser_navigate",
    title: "Browser Navigate",
    description: "Navigate the active tab to a URL. Returns an updated snapshot after navigation.",
    inputSchema: z.object({
      url: z.string().url().describe("URL to navigate to")
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
    name: "browser_go_back",
    title: "Browser Go Back",
    description: "Navigate back in the active tab's browser history. Returns an updated snapshot.",
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
    name: "browser_go_forward",
    title: "Browser Go Forward",
    description: "Navigate forward in the active tab's browser history. Returns an updated snapshot.",
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
    title: "Browser Wait For",
    description: "Wait until text or a URL pattern appears in the active tab, then return the snapshot.",
    inputSchema: z.object({
      text: z.string().optional().describe("Wait until this text appears in the page snapshot"),
      url: z.string().optional().describe("Wait until the active tab URL contains this string"),
      timeout: z.number().optional().describe("Timeout in milliseconds, default 5000")
    })
  },
  handle: async (args, runtime) => {
    const snap = await runtime.waitFor(
      {
        ...(args.text !== undefined ? { text: args.text } : {}),
        ...(args.url !== undefined ? { url: args.url } : {})
      },
      args.timeout ?? 5000
    );
    return textResult(formatSnapshot(snap));
  }
});

export default [navigate, goBack, goForward, waitFor];
