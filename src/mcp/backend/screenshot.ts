import { writeFile } from "node:fs/promises";
import { z } from "zod";
import { defineTool } from "./tool.js";

const screenshot = defineTool({
  capability: "core",
  schema: {
    name: "browser_take_screenshot",
    title: "Browser Take Screenshot",
    description: "Capture a full-page screenshot of the active tab as a base64-encoded PNG.",
    inputSchema: z.object({
      element: z.string().optional().describe("Human-readable description of the area to screenshot"),
      target: z.string().optional().describe("Element reference or CSS selector to clip screenshot to; omit for full page"),
      type: z.enum(["png", "jpeg"]).default("png").describe("Image format for the screenshot. Default is png."),
      filename: z.string().optional().describe("File name to save the screenshot to."),
      fullPage: z.boolean().optional().describe("When true, takes a screenshot of the full scrollable page, instead of the currently visible viewport. Cannot be used with element screenshots.")
    }),
    type: "readOnly"
  },
  handle: async (context, args, response) => {
    const result = await context.runtime.takeScreenshot({
      type: args.type,
      ...(args.fullPage !== undefined ? { fullPage: args.fullPage } : {}),
      ...(args.target !== undefined ? { target: args.target } : {})
    });
    const requestedFilename = args.filename?.trim();
    const resolvedFilename = await context.resolveOutputFile(
      requestedFilename || `page-${new Date().toISOString().replaceAll(":", "-")}.${args.type}`
    );
    await writeFile(resolvedFilename, Buffer.from(result.data, "base64"));
    if (requestedFilename) {
      response.addTextResult(`Screenshot saved to "${resolvedFilename}".`);
      return;
    }
    response.addTextResult(resolvedFilename);
    response.addImageResult(result.data, result.mimeType);
  }
});

export default [screenshot];
