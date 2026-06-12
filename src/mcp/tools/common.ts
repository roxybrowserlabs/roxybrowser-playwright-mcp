import { z } from "zod";
import { defineTool, textResult } from "../tool.js";
import { formatSnapshot, formatTabs } from "../format.js";

const close = defineTool({
  schema: {
    name: "browser_close",
    title: "Close browser",
    description: "Close the page",
    inputSchema: z.object({})
  },
  handle: async (_args, runtime) => {
    await runtime.close();
    return textResult(formatTabs([]));
  }
});

const resize = defineTool({
  schema: {
    name: "browser_resize",
    title: "Resize browser window",
    description: "Resize the browser window",
    inputSchema: z.object({
      width: z.number().describe("Width of the browser window"),
      height: z.number().describe("Height of the browser window")
    })
  },
  handle: async (args, runtime) => {
    const snap = await runtime.resize(args.width, args.height);
    if (!snap) return textResult(`Resized browser window to ${args.width}x${args.height}.`);
    return textResult(formatSnapshot(snap));
  }
});

export default [close, resize];
