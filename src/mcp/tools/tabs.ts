import { z } from "zod";
import { defineTool, textResult } from "../tool.js";
import { formatTabs, formatTabsWithOptionalSnapshot } from "../format.js";

const tabs = defineTool({
  schema: {
    name: "browser_tabs",
    title: "Browser Tabs",
    description: "List, create, select, and close browser tabs for the current MCP browser session.",
    inputSchema: z.object({
      action: z.enum(["list", "new", "select", "close"]),
      index: z.number().int().nonnegative().optional(),
      url: z.string().url().optional()
    })
  },
  handle: async (args, runtime) => {
    if (args.action === "list") {
      const tabList = await runtime.listTabs();
      return textResult(formatTabs(tabList));
    }

    if (args.action === "new") {
      const result = await runtime.newTab(args.url);
      return textResult(formatTabsWithOptionalSnapshot(result.tabs, result.snapshot));
    }

    if (args.action === "select") {
      const result = await runtime.selectTab(args.index as number);
      return textResult(formatTabsWithOptionalSnapshot(result.tabs, result.snapshot));
    }

    // close
    const result = await runtime.closeTab(args.index as number);
    return textResult(formatTabsWithOptionalSnapshot(result.tabs, result.snapshot));
  }
});

export default [tabs];
