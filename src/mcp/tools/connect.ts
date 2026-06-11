import { z } from "zod";
import { defineTool, textResult } from "../tool.js";
import { formatConnectResult } from "../format.js";

const connect = defineTool({
  schema: {
    name: "roxy_browser_connect",
    title: "Roxy Browser Connect",
    description: "Attach to an existing browser over CDP or BiDi and seed the active tab snapshot.",
    inputSchema: z.object({
      protocol: z.enum(["cdp", "bidi"]),
      endpoint: z.string().min(1),
      browser: z.enum(["chromium", "firefox"]).optional()
    })
  },
  handle: async (args, runtime) => {
    const result = await runtime.connect({
      protocol: args.protocol,
      endpoint: args.endpoint,
      ...(args.browser ? { browser: args.browser } : {})
    });
    return textResult(formatConnectResult(result));
  }
});

export default [connect];
