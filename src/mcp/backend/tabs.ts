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
      url: z.string().optional().describe("URL to navigate to in the new tab, used for new.")
    }),
    type: "action"
  },
  handle: async (context, params, response) => {
    switch (params.action) {
      case "list":
        await context.ensureTab();
        break;
      case "new":
        await context.runtime.newTab(params.url);
        if (params.url) {
          response.setIncludeSnapshot();
          response.addCode(`await page.goto('${params.url}');`);
        }
        break;
      case "close":
        await context.runtime.closeTab(params.index ?? 0);
        break;
      case "select":
        if (params.index === undefined) {
          throw new Error("Tab index is required");
        }
        await context.runtime.selectTab(params.index);
        break;
    }
    const tabs = await context.runtime.listTabs();
    response.addTextResult(formatTabs(tabs));
  }
});

export default [tabs];
