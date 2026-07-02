import { z } from "zod";
import { McpToolError } from "../errors.js";
import { defineTabTool } from "./tool.js";

const elementTargetDescription = "Exact target element reference from the page snapshot, or a unique element selector. Omit to scroll the page.";

const humanSchema = z.object({
  profile: z.enum(["cautious", "balanced", "fast"]).optional().describe(
    "Humanization timing profile, defaults to balanced"
  )
}).optional();

const scroll = defineTabTool({
  capability: "core-input",
  schema: {
    name: "browser_scroll",
    title: "Scroll",
    description: "Scroll the page or a specific element",
    inputSchema: z.object({
      element: z.string().optional().describe(
        "Human-readable element description used to obtain permission to interact with the element"
      ),
      target: z.string().optional().describe(elementTargetDescription),
      deltaX: z.number().optional().describe(
        "Horizontal scroll delta in CSS pixels. Positive values scroll right; negative values scroll left. Defaults to 0."
      ),
      deltaY: z.number().optional().describe(
        "Vertical scroll delta in CSS pixels. Positive values scroll down; negative values scroll up. Defaults to 0."
      ),
      human: humanSchema.describe("Humanization settings for this scroll")
    }),
    type: "input"
  },

  handle: async (tab, params, response) => {
    const deltaX = params.deltaX ?? 0;
    const deltaY = params.deltaY ?? 0;
    if (deltaX === 0 && deltaY === 0) {
      throw new McpToolError(
        "invalid_input",
        "At least one of deltaX or deltaY must be non-zero."
      );
    }

    response.setIncludeSnapshot();
    if (params.target) {
      const { resolved } = await tab.targetLocator({ target: params.target, element: params.element });
      response.addTextResult(`Scrolled "${params.element ?? params.target}".`);
      response.addCode(
        `await page.${resolved}.evaluate(element => element.scrollBy({ left: ${deltaX}, top: ${deltaY}, behavior: "instant" }));`
      );
    } else {
      response.addTextResult("Scrolled page.");
      response.addCode(
        `await page.evaluate(() => document.scrollingElement?.scrollBy({ left: ${deltaX}, top: ${deltaY}, behavior: "instant" }));`
      );
    }

    await tab.waitForCompletion(async () => {
      await tab.context.runtime.scroll(
        params.target ?? null,
        deltaX,
        deltaY,
        params.human?.profile !== undefined ? { profile: params.human.profile } : undefined
      );
    });
  }
});

export default [scroll];
