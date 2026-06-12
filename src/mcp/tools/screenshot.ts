import { writeFile } from "node:fs/promises";
import { z } from "zod";
import { defineTool, textResult } from "../tool.js";

const takeScreenshot = defineTool({
  schema: {
    name: "browser_take_screenshot",
    title: "Browser Take Screenshot",
    description: "Capture a full-page screenshot of the active tab as a base64-encoded PNG.",
    inputSchema: z.object({
      element: z.string().optional().describe(
        "Human-readable description of the area to screenshot"
      ),
      target: z.string().optional().describe(
        "Element reference or CSS selector to clip screenshot to; omit for full page"
      ),
      type: z.enum(["png", "jpeg"]).default("png").describe("Image format for the screenshot. Default is png."),
      filename: z.string().optional().describe("File name to save the screenshot to."),
      fullPage: z.boolean().optional().describe("When true, takes a screenshot of the full scrollable page, instead of the currently visible viewport. Cannot be used with element screenshots.")
    })
  },
  handle: async (args, runtime) => {
    const target = args.target;
    const result = await runtime.takeScreenshot({
      type: args.type,
      ...(args.fullPage !== undefined ? { fullPage: args.fullPage } : {}),
      ...(target !== undefined ? { target } : {})
    });
    if (args.filename) {
      await writeFile(args.filename, Buffer.from(result.data, "base64"));
      return textResult(`Screenshot saved to "${args.filename}".`);
    }
    return {
      content: [{ type: "image", data: result.data, mimeType: result.mimeType }]
    };
  }
});

export default [takeScreenshot];
