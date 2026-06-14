import { z } from "zod";
import { defineTabTool } from "./tool.js";
import { elementSchema } from "./snapshot.js";

const typeSchema = elementSchema.extend({
  text: z.string().describe("Text to type into the element"),
  submit: z.boolean().optional().describe("Whether to submit entered text (press Enter after)"),
  slowly: z.boolean().optional().describe(
    "Whether to type one character at a time. Useful for triggering key handlers in the page. By default entire text is filled in at once."
  )
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
      )
    }),
    type: "input"
  },

  handle: async (tab, params, response) => {
    response.setIncludeSnapshot();
    response.addTextResult(`Pressed key "${params.key}".`);
    response.addCode(`await page.keyboard.press(${JSON.stringify(params.key)});`);
    await tab.waitForCompletion(async () => {
      await tab.pressKey(params.key);
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
    if (params.slowly) {
      response.addCode(`await page.${resolved}.pressSequentially(${JSON.stringify(params.text)});`);
      if (params.submit) {
        response.addCode(`await page.${resolved}.press('Enter');`);
      }
    } else {
      response.addCode(`await page.${resolved}.fill(${JSON.stringify(params.text)});`);
      if (params.submit) {
        response.addCode(`await page.${resolved}.press('Enter');`);
      }
    }

    await tab.waitForCompletion(async () => {
      await locator.type(params.text, {
        ...(params.submit !== undefined ? { submit: params.submit } : {}),
        ...(params.slowly !== undefined ? { slowly: params.slowly } : {}),
        ...tab.actionTimeoutOptions
      });
    });
  }
});

export default [
  press,
  type
];
