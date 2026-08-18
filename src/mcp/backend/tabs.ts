import { z } from "zod";
import { defineTool } from "./tool.js";
import { formatTabs } from "../format.js";

const tabs = defineTool({
  capability: "core-tabs",
  schema: {
    name: "browser_tabs",
    title: "Browser Tabs",
    description: "List, create, select, and close browser tabs for the current MCP browser session.",
    inputSchema: z.object({
      action: z.enum(["list", "new", "select", "close"]).describe("Operation to perform"),
      index: z.number().optional().describe("Tab index, used for close/select. If omitted for close, current tab is closed."),
      url: z.string().optional().describe("URL to navigate to in the new tab, used for new."),
      activate: z.boolean().optional().describe(
        "Whether to activate the browser UI for new/select/close. Defaults to true for compatibility. Set false so background automation does not steal OS focus. Background new tabs require Chromium 145 or newer."
      )
    }),
    type: "action"
  },
  handle: async (context, params, response) => {
    switch (params.action) {
      case "list":
        await context.ensureTab();
        break;
      case "new":
        await context.runtime.newTab(params.url, params.activate ?? true);
        if (params.url) {
          response.setIncludeSnapshot();
          response.addCode(`await page.goto('${params.url}');`);
        }
        break;
      case "close":
        await context.runtime.closeTab(params.index ?? 0, params.activate ?? true);
        break;
      case "select":
        if (params.index === undefined) {
          throw new Error("Tab index is required");
        }
        await context.runtime.selectTab(params.index, params.activate ?? true);
        break;
    }
    const tabs = await context.runtime.listTabs();
    response.addTextResult(formatTabs(tabs));
  }
});

export default [tabs];
