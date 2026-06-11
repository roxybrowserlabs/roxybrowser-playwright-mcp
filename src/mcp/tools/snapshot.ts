import { writeFile } from "node:fs/promises";
import { z } from "zod";
import { defineTool, textResult } from "../tool.js";
import { formatSnapshot, formatTabs } from "../format.js";

const snapshot = defineTool({
  schema: {
    name: "browser_snapshot",
    title: "Browser Snapshot",
    description: "Return a Playwright-style accessibility and DOM snapshot for the active tab.",
    inputSchema: z.object({
      target: z.string().optional(),
      filename: z.string().optional(),
      depth: z.number().optional(),
      boxes: z.boolean().optional()
    }).strict(),
    listedInputSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        target: {
          type: "string",
          description: "Exact target element reference from the page snapshot, or a unique element selector"
        },
        filename: {
          type: "string",
          description: "Save snapshot to markdown file instead of returning it in the response."
        },
        depth: {
          type: "number",
          description: "Limit the depth of the snapshot tree"
        },
        boxes: {
          type: "boolean",
          description: "Include each element's bounding box as [box=x,y,width,height] in the snapshot. Coordinates are viewport-relative, in CSS pixels (Element.getBoundingClientRect)"
        }
      },
      additionalProperties: false
    }
  },
  handle: async (args, runtime) => {
    const snap = await runtime.snapshot(args);
    if (args.filename) {
      await writeFile(args.filename, snap.text);
      return textResult(`Saved snapshot to "${args.filename}".`);
    }
    const tabs = await runtime.listTabs();
    return textResult(`${formatTabs(tabs)}\n${formatSnapshot(snap)}`);
  }
});

export default [snapshot];
