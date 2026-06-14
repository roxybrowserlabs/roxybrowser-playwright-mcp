import { z } from "zod";
import { defineTool, textResult } from "../tool.js";
import { formatSnapshot } from "../format.js";

const elementTargetDescription = "Exact target element reference from the page snapshot, or a unique element selector";

const elementSchema = z.object({
  element: z.string().optional().describe(
    "Human-readable element description used to obtain permission"
  ),
  target: z.string().describe(elementTargetDescription)
});

const selectOption = defineTool({
  schema: {
    name: "browser_select_option",
    title: "Select option",
    description: "Select an option in a dropdown. Returns selected values and an updated snapshot.",
    inputSchema: elementSchema.extend({
      values: z.array(z.string()).describe("Option values or visible labels to select")
    })
  },
  handle: async (args, runtime) => {
    const result = await runtime.selectOption(args.target, args.values);
    const header = `Selected options: ${result.selected.join(", ")}`;
    if (!result.snapshot) return textResult(header);
    return textResult(`${header}\n\n${formatSnapshot(result.snapshot)}`);
  }
});

const check = defineTool({
  schema: {
    name: "browser_check",
    title: "Check",
    description: "Check a checkbox or radio button. Returns an updated snapshot.",
    inputSchema: elementSchema
  },
  handle: async (args, runtime) => {
    const snap = await runtime.check(args.target, true);
    if (!snap) return textResult(`Checked "${args.element ?? args.target}".`);
    return textResult(formatSnapshot(snap));
  }
});

const uncheck = defineTool({
  schema: {
    name: "browser_uncheck",
    title: "Uncheck",
    description: "Uncheck a checkbox or radio button. Returns an updated snapshot.",
    inputSchema: elementSchema
  },
  handle: async (args, runtime) => {
    const snap = await runtime.check(args.target, false);
    if (!snap) return textResult(`Unchecked "${args.element ?? args.target}".`);
    return textResult(formatSnapshot(snap));
  }
});

const fileUpload = defineTool({
  schema: {
    name: "browser_file_upload",
    title: "Upload files",
    description: "Upload one or multiple files",
    inputSchema: z.object({
      paths: z.array(z.string()).optional().describe("The absolute paths to the files to upload. Can be single file or multiple files. If omitted, file chooser is cancelled.")
    }),
    listedInputSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        paths: {
          type: "array",
          items: { type: "string" },
          description: "The absolute paths to the files to upload. Can be single file or multiple files. If omitted, file chooser is cancelled."
        }
      },
      additionalProperties: false
    }
  },
  handle: async (args, runtime) => {
    const snap = await runtime.uploadFile(args.paths ?? []);
    if (!snap) return textResult(`Uploaded ${args.paths?.length ?? 0} file(s).`);
    return textResult(formatSnapshot(snap));
  }
});

const fillForm = defineTool({
  schema: {
    name: "browser_fill_form",
    title: "Fill form",
    description: "Fill multiple form fields",
    inputSchema: z.object({
      fields: z.array(z.object({
        name: z.string().describe("Human-readable field name"),
        type: z.enum(["textbox", "checkbox", "radio", "combobox", "slider"]).describe("Type of the field"),
        target: z.string().describe("Exact target element reference from the page snapshot, or a unique element selector"),
        value: z.string().describe("Value to fill in the field. If the field is a checkbox, the value should be `true` or `false`. If the field is a combobox, the value should be the text of the option.")
      })).describe("Fields to fill in")
    })
  },
  handle: async (args, runtime) => {
    const snap = await runtime.fillForm(args.fields);
    if (!snap) return textResult("Filled form.");
    return textResult(formatSnapshot(snap));
  }
});

const drop = defineTool({
  schema: {
    name: "browser_drop",
    title: "Drop files or data onto an element",
    description: "Drop files or MIME-typed data onto an element, as if dragged from outside the page. At least one of paths or data must be provided.",
    inputSchema: z.object({
      element: z.string().optional().describe("Human-readable element description used to obtain permission to interact with the element"),
      target: z.string().describe("Exact target element reference from the page snapshot, or a unique element selector"),
      paths: z.array(z.string()).optional().describe("Absolute paths to files to drop onto the element."),
      data: z.record(z.string(), z.string()).optional().describe("Data to drop, as a map of MIME type to string value.")
    })
  },
  handle: async (args, runtime) => {
    if (!args.paths?.length && !args.data) {
      throw new Error('At least one of "paths" or "data" must be provided.');
    }
    const snap = await runtime.drop(args.target, {
      ...(args.paths !== undefined ? { paths: args.paths } : {}),
      ...(args.data !== undefined ? { data: args.data } : {})
    });
    if (!snap) return textResult(`Dropped data onto "${args.element ?? args.target}".`);
    return textResult(formatSnapshot(snap));
  }
});

export default [fillForm, drop];
