import { z } from "zod";
import { defineTabTool } from "./tool.js";

const humanSchema = z.object({
  profile: z.enum(["cautious", "balanced", "fast"]).optional().describe(
    "Humanization timing profile, defaults to balanced"
  )
}).optional();

type HumanParams = z.output<typeof humanSchema>;

function humanOptions(human: HumanParams): { profile?: string } | undefined {
  return human?.profile !== undefined ? { profile: human.profile } : undefined;
}

function mouseClickOptionsCode(params: {
  button?: "left" | "right" | "middle";
  clickCount?: number;
  delay?: number;
}): string {
  const entries: string[] = [];
  if (params.button !== undefined) {
    entries.push(`button: ${JSON.stringify(params.button)}`);
  }
  if (params.clickCount !== undefined) {
    entries.push(`clickCount: ${params.clickCount}`);
  }
  if (params.delay !== undefined) {
    entries.push(`delay: ${params.delay}`);
  }
  return entries.length ? `, { ${entries.join(", ")} }` : "";
}

export const mouseMove = defineTabTool({
  capability: "vision",
  schema: {
    name: "browser_mouse_move_xy",
    title: "Move mouse",
    description: "Move mouse to a given position",
    inputSchema: z.object({
      x: z.number().describe("X coordinate"),
      y: z.number().describe("Y coordinate"),
      human: humanSchema.describe("Humanization settings for this mouse move")
    }),
    type: "input"
  },

  handle: async (tab, params, response) => {
    response.addCode(`// Move mouse to (${params.x}, ${params.y})`);
    response.addCode(`await page.mouse.move(${params.x}, ${params.y});`);
    await tab.context.runtime.mouseMove(params.x, params.y, humanOptions(params.human));
  }
});

export const mouseClick = defineTabTool({
  capability: "vision",
  schema: {
    name: "browser_mouse_click_xy",
    title: "Click",
    description: "Click mouse button at a given position",
    inputSchema: z.object({
      x: z.number().describe("X coordinate"),
      y: z.number().describe("Y coordinate"),
      button: z.enum(["left", "right", "middle"]).optional().describe("Button to click, defaults to left"),
      clickCount: z.number().optional().describe("Number of clicks, defaults to 1"),
      delay: z.number().optional().describe("Time to wait between mouse down and mouse up in milliseconds, defaults to 0"),
      human: humanSchema.describe("Humanization settings for this mouse click")
    }),
    type: "input"
  },

  handle: async (tab, params, response) => {
    response.setIncludeSnapshot();
    response.addCode(`// Click mouse at coordinates (${params.x}, ${params.y})`);
    const clickOptions = {
      ...(params.button !== undefined ? { button: params.button } : {}),
      ...(params.clickCount !== undefined ? { clickCount: params.clickCount } : {}),
      ...(params.delay !== undefined ? { delay: params.delay } : {})
    };
    response.addCode(`await page.mouse.click(${params.x}, ${params.y}${mouseClickOptionsCode(clickOptions)});`);

    await tab.waitForCompletion(async () => {
      const human = humanOptions(params.human);
      await tab.context.runtime.mouseClick(params.x, params.y, {
        ...clickOptions,
        ...(human !== undefined ? { human } : {})
      });
    });
  }
});

export const mouseDrag = defineTabTool({
  capability: "vision",
  schema: {
    name: "browser_mouse_drag_xy",
    title: "Drag mouse",
    description: "Drag left mouse button to a given position",
    inputSchema: z.object({
      startX: z.number().describe("Start X coordinate"),
      startY: z.number().describe("Start Y coordinate"),
      endX: z.number().describe("End X coordinate"),
      endY: z.number().describe("End Y coordinate"),
      human: humanSchema.describe("Humanization settings for this mouse drag")
    }),
    type: "input"
  },

  handle: async (tab, params, response) => {
    response.setIncludeSnapshot();
    response.addCode(`// Drag mouse from (${params.startX}, ${params.startY}) to (${params.endX}, ${params.endY})`);
    response.addCode(`await page.mouse.move(${params.startX}, ${params.startY});`);
    response.addCode("await page.mouse.down();");
    response.addCode(`await page.mouse.move(${params.endX}, ${params.endY});`);
    response.addCode("await page.mouse.up();");

    await tab.waitForCompletion(async () => {
      await tab.context.runtime.mouseDrag(params.startX, params.startY, params.endX, params.endY, humanOptions(params.human));
    });
  }
});

export default [
  mouseMove,
  mouseClick,
  mouseDrag
];
