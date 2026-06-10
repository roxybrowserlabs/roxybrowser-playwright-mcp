import { writeFile } from "node:fs/promises";
import { z } from "zod";
import { defineTool, textResult } from "../tool.js";
import { formatSnapshot } from "../format.js";

const snapshot = defineTool({
  schema: {
    name: "browser_snapshot",
    title: "Browser Snapshot",
    description: "Return a Playwright-style accessibility and DOM snapshot for the active tab.",
    inputSchema: z.object({
      target: z.string().min(1).optional(),
      filename: z.string().min(1).optional(),
      depth: z.number().optional(),
      boxes: z.boolean().optional()
    })
  },
  handle: async (args, runtime) => {
    const snap = await runtime.snapshot(args);
    if (args.filename) {
      await writeFile(args.filename, snap.text);
      return textResult(`Saved snapshot to "${args.filename}".`);
    }
    return textResult(formatSnapshot(snap));
  }
});

export default [snapshot];
