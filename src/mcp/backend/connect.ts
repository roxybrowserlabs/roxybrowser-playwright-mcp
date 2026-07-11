import { z } from "zod";
import { formatConnectResult } from "../format.js";
import { defineTool } from "./tool.js";

const connect = defineTool({
  capability: "config",
  schema: {
    name: "roxy_browser_connect",
    title: "Roxy Browser Connect",
    description: "Attach to an existing browser and seed the active tab snapshot.",
    inputSchema: z.object({
      endpoint: z.string().min(1),
      browser: z.enum(["chrome", "firefox"]).default("chrome"),
      sessionId: z.string().min(1).optional()
    }),
    type: "action"
  },
  handle: async (context, params, response) => {
    const protocol = params.browser === "firefox" ? "bidi" : "cdp";
    const result = await context.runtime.connect({
      protocol,
      endpoint: params.endpoint,
      browser: params.browser === "chrome" ? "chromium" : params.browser,
      ...(params.sessionId ? { sessionId: params.sessionId } : {})
    });
    await context.runtime.ensureActiveCursorVisualization().catch(() => undefined);
    response.addTextResult(
      formatConnectResult({
        ...result,
        browserName: result.browserName === "chromium" ? "chrome" : result.browserName
      })
    );
  }
});

export default [connect];
