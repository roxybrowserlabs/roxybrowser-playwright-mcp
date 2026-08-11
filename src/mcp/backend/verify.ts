import { z } from "zod";
import { defineTabTool } from "./tool.js";
import { escapeWithQuotes } from "./utils.js";

const verifyElement = defineTabTool({
  capability: "testing",
  schema: {
    name: "browser_verify_element_visible",
    title: "Verify element visible",
    description: "Verify element is visible on the page",
    inputSchema: z.object({
      role: z.string().describe("ROLE of the element. Can be found in the snapshot like this: `- {ROLE} \"Accessible Name\":`"),
      accessibleName: z.string().describe("ACCESSIBLE_NAME of the element. Can be found in the snapshot like this: `- role \"{ACCESSIBLE_NAME}\"`")
    }),
    type: "assertion"
  },
  handle: async (tab, params, response) => {
    const count = await tab.context.runtime.countByRole(params.role, params.accessibleName);
    if (count === 0) {
      response.addError(`Element with role "${params.role}" and accessible name "${params.accessibleName}" not found`);
      return;
    }
    response.addCode(`await expect(page.getByRole(${escapeWithQuotes(params.role)}, { name: ${escapeWithQuotes(params.accessibleName)} })).toBeVisible();`);
    response.addTextResult("Done");
  }
});

const verifyText = defineTabTool({
  capability: "testing",
  schema: {
    name: "browser_verify_text_visible",
    title: "Verify text visible",
    description: `Verify text is visible on the page. Prefer ${verifyElement.schema.name} if possible.`,
    inputSchema: z.object({
      text: z.string().describe("TEXT to verify. Can be found in the snapshot like this: `- role \"Accessible Name\": {TEXT}` or like this: `- text: {TEXT}`")
    }),
    type: "assertion"
  },
  handle: async (tab, params, response) => {
    const matches = await tab.context.runtime.textContentsByText(params.text, { visible: true });
    if (matches.length === 0) {
      response.addError("Text not found");
      return;
    }
    response.addCode(`await expect(page.getByText(${escapeWithQuotes(params.text)}).filter({ visible: true })).toBeVisible();`);
    response.addTextResult("Done");
  }
});

const verifyList = defineTabTool({
  capability: "testing",
  schema: {
    name: "browser_verify_list_visible",
    title: "Verify list visible",
    description: "Verify list is visible on the page",
    inputSchema: z.object({
      element: z.string().describe("Human-readable list description"),
      target: z.string().describe("Exact target element reference that points to the list"),
      items: z.array(z.string()).describe("Items to verify")
    }),
    type: "assertion"
  },
  handle: async (tab, params, response) => {
    const { locator } = await tab.targetLocator(params);
    const itemTexts: string[] = [];
    for (const item of params.items) {
      const itemLocator = locator.getByText(item);
      if (await itemLocator.count() === 0) {
        response.addError(`Item "${item}" not found`);
        return;
      }
      itemTexts.push(...await itemLocator.textContents());
    }
    const ariaSnapshot = "`\n- list:\n" + itemTexts.map((item) => `  - listitem: ${escapeWithQuotes(item, "\"")}`).join("\n") + "\n`";
    response.addCode(`await expect(page.locator('body')).toMatchAriaSnapshot(${ariaSnapshot});`);
    response.addTextResult("Done");
  }
});

const verifyValue = defineTabTool({
  capability: "testing",
  schema: {
    name: "browser_verify_value",
    title: "Verify value",
    description: "Verify element value",
    inputSchema: z.object({
      type: z.enum(["textbox", "checkbox", "radio", "combobox", "slider"]).describe("Type of the element"),
      element: z.string().describe("Human-readable element description"),
      target: z.string().describe("Exact target element reference from the page snapshot"),
      value: z.string().describe("Value to verify. For checkbox, use \"true\" or \"false\".")
    }),
    type: "assertion"
  },
  handle: async (tab, params, response) => {
    const { locator, resolved } = await tab.targetLocator(params);
    const locatorSource = `page.${resolved}`;
    if (params.type === "checkbox" || params.type === "radio") {
      const value = await locator.isChecked(tab.expectTimeoutOptions);
      if (value !== (params.value === "true")) {
        response.addError(`Expected value "${params.value}", but got "${value}"`);
        return;
      }
      const matcher = value ? "toBeChecked" : "not.toBeChecked";
      response.addCode(`await expect(${locatorSource}).${matcher}();`);
    } else {
      const value = await locator.inputValue(tab.expectTimeoutOptions);
      if (value !== params.value) {
        response.addError(`Expected value "${params.value}", but got "${value}"`);
        return;
      }
      response.addCode(`await expect(${locatorSource}).toHaveValue(${escapeWithQuotes(params.value)});`);
    }
    response.addTextResult("Done");
  }
});

export default [
  verifyElement,
  verifyText,
  verifyList,
  verifyValue
];
