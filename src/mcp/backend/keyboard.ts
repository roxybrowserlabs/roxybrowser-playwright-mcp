import { z } from "zod";
import { defineTabTool } from "./tool.js";
import { elementSchema } from "./snapshot.js";
import type { HumanizationOptions } from "../../human/types.js";

const humanSchema = z.object({
  profile: z.enum(["cautious", "balanced", "fast"]).optional().describe(
    "Humanization timing profile, defaults to balanced"
  )
}).optional();

function toHumanizationOptions(human: z.output<typeof humanSchema>): HumanizationOptions | undefined {
  return human?.profile !== undefined ? { profile: human.profile } : undefined;
}

const typeSchema = elementSchema.extend({
  text: z.string().describe("Text to type into the element"),
  submit: z.boolean().optional().describe("Whether to submit entered text (press Enter after)"),
  slowly: z.boolean().optional().describe("Whether to type one character at a time. Useful for triggering key handlers in the page. By default the entire text is filled in at once."),
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
    response.addTextResult(`Pressed key "${params.key}".`);
    response.addCode(`// Press ${params.key}`);
    response.addCode(`await page.keyboard.press(${JSON.stringify(params.key)});`);
    const action = async () => {
      await tab.context.runtime.pressKey(params.key, undefined, toHumanizationOptions(params.human));
    };
    if (params.key === "Enter") {
      response.setIncludeSnapshot();
      await tab.waitForCompletion(action);
    } else {
      await action();
    }
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
    response.addTextResult(`Typed into "${params.element ?? params.target}".`);

    const { locator, resolved } = await tab.targetLocator(params);
    const secret = tab.context.lookupSecret(params.text);
    const actionOptions = {
      ...(params.human !== undefined ? { human: params.human } : {}),
      ...tab.actionTimeoutOptions
    };
    const action = async () => {
      if (params.slowly) {
        response.setIncludeSnapshot();
        response.addCode(`await page.${resolved}.pressSequentially(${secret.code});`);
        await locator.pressSequentially(secret.value, actionOptions);
      } else {
        response.addCode(`await page.${resolved}.fill(${secret.code});`);
        await locator.fill(secret.value, actionOptions);
      }
      if (params.submit) {
        response.setIncludeSnapshot();
        response.addCode(`await page.${resolved}.press('Enter');`);
        await locator.press("Enter", actionOptions);
      }
    };

    if (params.submit || params.slowly) {
      await tab.waitForCompletion(action);
    } else {
      await action();
    }
  }
});

export const pressSequentially = defineTabTool({
  capability: "core-input",
  skillOnly: true,
  schema: {
    name: "browser_press_sequentially",
    title: "Type text key by key",
    description: "Type text key by key on the keyboard",
    inputSchema: z.object({
      text: z.string().describe("Text to type"),
      submit: z.boolean().optional().describe("Whether to submit entered text (press Enter after)"),
      human: humanSchema.describe("Humanization settings for this typing action")
    }),
    type: "input"
  },

  handle: async (tab, params, response) => {
    response.addCode(`// Press ${params.text}`);
    response.addCode(`await page.keyboard.type(${JSON.stringify(params.text)});`);
    if (params.submit) {
      response.addCode(`await page.keyboard.press('Enter');`);
      response.setIncludeSnapshot();
    }

    const typeAction = async () => {
      if (params.human !== undefined) {
        const human = toHumanizationOptions(params.human);
        await tab.context.runtime.pressSequentially(
          params.text,
          human !== undefined
            ? { human }
            : undefined
        );
      } else {
        await tab.context.runtime.pressSequentially(params.text);
      }
    };

    await typeAction();
    if (params.submit) {
      await tab.waitForCompletion(async () => {
        await tab.context.runtime.pressKey("Enter", undefined, toHumanizationOptions(params.human));
      });
    }
  }
});

export const keydown = defineTabTool({
  capability: "core-input",
  skillOnly: true,
  schema: {
    name: "browser_keydown",
    title: "Press a key down",
    description: "Press a key down on the keyboard",
    inputSchema: z.object({
      key: z.string().describe("Name of the key to press or a character to generate, such as `ArrowLeft` or `a`")
    }),
    type: "input"
  },

  handle: async (tab, params, response) => {
    response.addCode(`await page.keyboard.down(${JSON.stringify(params.key)});`);
    await tab.context.runtime.keyDown(params.key);
  }
});

export const keyup = defineTabTool({
  capability: "core-input",
  skillOnly: true,
  schema: {
    name: "browser_keyup",
    title: "Press a key up",
    description: "Press a key up on the keyboard",
    inputSchema: z.object({
      key: z.string().describe("Name of the key to press or a character to generate, such as `ArrowLeft` or `a`")
    }),
    type: "input"
  },

  handle: async (tab, params, response) => {
    response.addCode(`await page.keyboard.up(${JSON.stringify(params.key)});`);
    await tab.context.runtime.keyUp(params.key);
  }
});

export default [
  press,
  type,
  pressSequentially,
  keydown,
  keyup
];
