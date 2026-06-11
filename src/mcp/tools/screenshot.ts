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
      ref: z.string().optional().describe(
        "Element reference or CSS selector to clip screenshot to; omit for full page"
      ),
      filename: z.string().optional().describe("Save screenshot to this file path")
    })
  },
  handle: async (args, runtime) => {
    const data = await runtime.takeScreenshot();
    if (args.filename) {
      await writeFile(args.filename, Buffer.from(data, "base64"));
      return textResult(`Screenshot saved to "${args.filename}".`);
    }
    return {
      content: [{ type: "image", data, mimeType: "image/png" }]
    };
  }
});

export default [takeScreenshot];
