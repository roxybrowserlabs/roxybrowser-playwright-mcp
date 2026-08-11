import { z } from "zod";
import { defineTabTool } from "./tool.js";
import { elementSchema } from "./snapshot.js";
import { escapeWithQuotes } from "./utils.js";

const fillForm = defineTabTool({
  capability: "core",
  schema: {
    name: "browser_fill_form",
    title: "Fill form",
    description: "Fill multiple form fields",
    inputSchema: z.object({
      human: z.object({
        profile: z.enum(["cautious", "balanced", "fast"]).optional().describe(
          "Humanization timing profile, defaults to balanced"
        )
      }).optional().describe("Humanization settings for text input fields"),
      fields: z.array(elementSchema.extend({
        name: z.string().describe("Human-readable field name"),
        type: z.enum(["textbox", "checkbox", "radio", "combobox", "slider"]).describe("Type of the field"),
        value: z.string().describe("Value to fill in the field. If the field is a checkbox, the value should be `true` or `false`. If the field is a combobox, the value should be the text of the option.")
      })).describe("Fields to fill in")
    }),
    type: "input"
  },

  handle: async (tab, params, response) => {
    const fields = [];
    for (const field of params.fields) {
      const { resolved } = await tab.targetLocator({ element: field.name, target: field.target });
      const locatorSource = `await page.${resolved}`;
      if (field.type === "textbox" || field.type === "slider") {
        const secret = tab.context.lookupSecret(field.value);
        response.addCode(`${locatorSource}.fill(${secret.code});`);
        fields.push({ ...field, value: secret.value });
      } else if (field.type === "checkbox" || field.type === "radio") {
        response.addCode(`${locatorSource}.setChecked(${field.value});`);
        fields.push(field);
      } else {
        response.addCode(`${locatorSource}.selectOption(${escapeWithQuotes(field.value)});`);
        fields.push(field);
      }
    }

    const snapshot = await tab.context.runtime.fillForm(
      fields,
      params.human as { profile?: string } | undefined
    );
    if (snapshot) {
      response.setIncludeSnapshot();
    }
  }
});

export default [
  fillForm
];
