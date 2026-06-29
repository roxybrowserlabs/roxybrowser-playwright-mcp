import { z } from "zod";
import { defineTabTool } from "./tool.js";
import { elementSchema } from "./snapshot.js";

const humanSchema = z.object({
  profile: z.enum(["cautious", "balanced", "fast"]).optional().describe(
    "Humanization timing profile, defaults to balanced"
  )
}).optional();

const typeSchema = elementSchema.extend({
  text: z.string().describe("Text to type into the element"),
  submit: z.boolean().optional().describe("Whether to submit entered text (press Enter after)"),
  human: humanSchema.describe("Humanization settings for this typing action")
});

export const press = defineTabTool({
  capability: "core-input",
  schema: {
    name: "browser_press_key",
    title: "Press a key",
    description: "Press a key on the keyboard",
    inputSchema: z.object({
      key: z.string().describe(
        "Key to press, e.g. Enter, Escape, Tab, ArrowLeft, Backspace, Delete, or printable characters"
      ),
      human: humanSchema.describe("Humanization settings for this key press")
    }),
    type: "input"
  },

  handle: async (tab, params, response) => {
    response.setIncludeSnapshot();
    response.addTextResult(`Pressed key "${params.key}".`);
    response.addCode(`await page.keyboard.press(${JSON.stringify(params.key)});`);
    await tab.waitForCompletion(async () => {
      await tab.context.runtime.pressKey(
        params.key,
        undefined,
        params.human?.profile !== undefined ? { profile: params.human.profile } : undefined
      );
    });
  }
});

export const type = defineTabTool({
  capability: "core-input",
  schema: {
    name: "browser_type",
    title: "Type text",
    description: "Type text into editable element",
    inputSchema: typeSchema,
    type: "input"
  },

  handle: async (tab, params, response) => {
    response.setIncludeSnapshot();
    response.addTextResult(`Typed into "${params.element ?? params.target}".`);

    const { locator, resolved } = await tab.targetLocator(params);
    response.addCode(`await page.${resolved}.fill(${JSON.stringify(params.text)});`);
    if (params.submit) {
      response.addCode(`await page.${resolved}.press('Enter');`);
    }

    await tab.waitForCompletion(async () => {
      await locator.type(params.text, {
        ...(params.submit !== undefined ? { submit: params.submit } : {}),
        ...(params.human !== undefined ? { human: params.human } : {}),
        ...tab.actionTimeoutOptions
      });
    });
  }
});

export default [
  press,
  type
];
