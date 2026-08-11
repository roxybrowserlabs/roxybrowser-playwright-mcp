import { z } from "zod";
import { defineTool } from "./tool.js";

const close = defineTool({
  capability: "core-tabs",
  schema: {
    name: "browser_close",
    title: "Close browser",
    description: "Close the current browser session.",
    inputSchema: z.object({}),
    type: "action"
  },
  handle: async (context, _params, response) => {
    await context.runtime.close();
    response.setClose();
    response.addCode("await page.close()");
  }
});

const resize = defineTool({
  capability: "core",
  schema: {
    name: "browser_resize",
    title: "Resize browser",
    description: "Resize the active page viewport.",
    inputSchema: z.object({
      width: z.number().int().positive(),
      height: z.number().int().positive()
    }),
    type: "action"
  },
  handle: async (context, params, response) => {
    await context.runtime.resize(params.width, params.height);
    response.setIncludeSnapshot();
    response.addCode(`await page.setViewportSize({ width: ${params.width}, height: ${params.height} });`);
  }
});

export default [close, resize];
