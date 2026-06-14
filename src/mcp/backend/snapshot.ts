import { z } from "zod";
import { defineTabTool } from "./tool.js";

const elementTargetDescription = "Exact target element reference from the page snapshot, or a unique element selector";

export const optionalElementSchema = z.object({
  element: z.string().optional().describe(
    "Human-readable element description used to obtain permission to interact with the element"
  ),
  target: z.string().optional().describe(elementTargetDescription)
});

export const elementSchema = z.object({
  element: z.string().optional().describe(
    "Human-readable element description used to obtain permission to interact with the element"
  ),
  target: z.string().describe(elementTargetDescription)
});

const clickSchema = elementSchema.extend({
  doubleClick: z.boolean().optional().describe(
    "Whether to perform a double click instead of a single click"
  ),
  button: z.enum(["left", "right", "middle"]).optional().describe(
    "Button to click, defaults to left"
  ),
  modifiers: z.array(z.enum(["Alt", "Control", "ControlOrMeta", "Meta", "Shift"])).optional().describe(
    "Modifier keys to press during the click"
  ),
  human: z.object({
    profile: z.enum(["cautious", "balanced", "fast"]).optional().describe(
      "Humanization timing profile, defaults to balanced"
    )
  }).optional().describe("Humanization settings for this click")
});

function optionsCode(params: z.output<typeof clickSchema>, hasTimeout: boolean): string {
  const entries: string[] = [];
  if (params.button !== undefined) {
    entries.push(`button: ${JSON.stringify(params.button)}`);
  }
  if (params.modifiers !== undefined) {
    entries.push(`modifiers: ${JSON.stringify(params.modifiers)}`);
  }
  if (hasTimeout) {
    entries.push("timeout");
  }
  return entries.length ? `{ ${entries.join(", ")} }` : "";
}

export const snapshot = defineTabTool({
  capability: "core",
  schema: {
    name: "browser_snapshot",
    title: "Page snapshot",
    description: "Capture accessibility snapshot of the current page, this is better than screenshot",
    inputSchema: z.object({
      target: z.string().optional().describe(elementTargetDescription),
      filename: z.string().optional().describe("Save snapshot to markdown file instead of returning it in the response."),
      depth: z.number().optional().describe("Limit the depth of the snapshot tree"),
      boxes: z.boolean().optional().describe("Include each element's bounding box as [box=x,y,width,height] in the snapshot. Coordinates are viewport-relative, in CSS pixels (Element.getBoundingClientRect)")
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
    },
    type: "readOnly"
  },

  handle: async (tab, params, response) => {
    if (params.target) {
      await tab.targetLocator({ target: params.target });
    }
    response.setIncludeFullSnapshot(params.filename, params.target, params.depth, params.boxes);
  }
});

export const click = defineTabTool({
  capability: "core",
  schema: {
    name: "browser_click",
    title: "Click",
    description: "Perform click on a web page",
    inputSchema: clickSchema,
    type: "input"
  },

  handle: async (tab, params, response) => {
    response.setIncludeSnapshot();
    response.addTextResult(`Clicked "${params.element ?? params.target}".`);

    const { locator, resolved } = await tab.targetLocator(params);
    const options = {
      ...(params.button !== undefined ? { button: params.button } : {}),
      ...(params.modifiers !== undefined ? { modifiers: params.modifiers } : {}),
      ...(params.human !== undefined ? { human: params.human } : {}),
      ...tab.actionTimeoutOptions
    };
    const codeOptions = optionsCode(params, "timeout" in tab.actionTimeoutOptions);

    if (params.doubleClick) {
      response.addCode(`await page.${resolved}.dblclick(${codeOptions});`);
    } else {
      response.addCode(`await page.${resolved}.click(${codeOptions});`);
    }

    await tab.waitForCompletion(async () => {
      if (params.doubleClick) {
        await locator.dblclick(options);
      } else {
        await locator.click(options);
      }
    });
  }
});

export const drag = defineTabTool({
  capability: "core",
  schema: {
    name: "browser_drag",
    title: "Drag mouse",
    description: "Perform drag and drop between two elements",
    inputSchema: z.object({
      startElement: z.string().optional().describe(
        "Human-readable source element description used to obtain the permission to interact with the element"
      ),
      startTarget: z.string().describe(elementTargetDescription),
      endElement: z.string().optional().describe(
        "Human-readable target element description used to obtain the permission to interact with the element"
      ),
      endTarget: z.string().describe(elementTargetDescription)
    }),
    type: "input"
  },

  handle: async (tab, params, response) => {
    response.setIncludeSnapshot();
    response.addTextResult(
      `Dragged "${params.startElement ?? params.startTarget}" to "${params.endElement ?? params.endTarget}".`
    );

    const locators = await tab.targetLocators([
      { target: params.startTarget, element: params.startElement },
      { target: params.endTarget, element: params.endElement }
    ]);
    const start = locators[0]!;
    const end = locators[1]!;

    await tab.waitForCompletion(async () => {
      await start.locator.dragTo(end.locator, tab.actionTimeoutOptions);
    });

    response.addCode(`await page.${start.resolved}.dragTo(page.${end.resolved});`);
  }
});

export const hover = defineTabTool({
  capability: "core",
  schema: {
    name: "browser_hover",
    title: "Hover mouse",
    description: "Hover over element on page",
    inputSchema: elementSchema,
    type: "input"
  },

  handle: async (tab, params, response) => {
    response.setIncludeSnapshot();

    const { locator, resolved } = await tab.targetLocator(params);
    response.addCode(`await page.${resolved}.hover();`);

    await locator.hover(tab.actionTimeoutOptions);
  }
});

const selectOptionSchema = elementSchema.extend({
  values: z.array(z.string()).describe("Option values or visible labels to select")
});

export const selectOption = defineTabTool({
  capability: "core",
  schema: {
    name: "browser_select_option",
    title: "Select option",
    description: "Select an option in a dropdown",
    inputSchema: selectOptionSchema,
    type: "input"
  },

  handle: async (tab, params, response) => {
    response.setIncludeSnapshot();

    const { locator, resolved } = await tab.targetLocator(params);
    response.addCode(`await page.${resolved}.selectOption(${JSON.stringify(params.values)});`);

    const selected = await locator.selectOption(params.values, tab.actionTimeoutOptions);
    response.addTextResult(`Selected options: ${selected.join(", ")}`);
  }
});

export default [
  snapshot,
  click,
  drag,
  hover,
  selectOption
];
