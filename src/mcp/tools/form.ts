import { z } from "zod";
import { defineTool, textResult } from "../tool.js";
import { formatSnapshot } from "../format.js";

const selectOption = defineTool({
  schema: {
    name: "browser_select_option",
    title: "Browser Select Option",
    description: "Select options in a <select> element. Returns selected values and an updated snapshot.",
    inputSchema: z.object({
      element: z.string().optional().describe(
        "Human-readable element description used to obtain permission"
      ),
      ref: z.string().describe(
        "Exact element reference from the page snapshot, or a unique CSS selector"
      ),
      values: z.array(z.string()).describe("Option values or visible labels to select")
    })
  },
  handle: async (args, runtime) => {
    const result = await runtime.selectOption(args.ref, args.values);
    const header = `Selected options: ${result.selected.join(", ")}`;
    if (!result.snapshot) return textResult(header);
    return textResult(`${header}\n\n${formatSnapshot(result.snapshot)}`);
  }
});

const check = defineTool({
  schema: {
    name: "browser_check",
    title: "Browser Check",
    description: "Check or uncheck a checkbox or radio button. Returns an updated snapshot.",
    inputSchema: z.object({
      element: z.string().optional().describe(
        "Human-readable element description used to obtain permission"
      ),
      ref: z.string().describe(
        "Exact element reference from the page snapshot, or a unique CSS selector"
      ),
      checked: z.boolean().optional().describe(
        "Whether to check (true) or uncheck (false), defaults to true"
      )
    })
  },
  handle: async (args, runtime) => {
    const checked = args.checked ?? true;
    const snap = await runtime.check(args.ref, checked);
    const action = checked ? "Checked" : "Unchecked";
    if (!snap) return textResult(`${action} "${args.element ?? args.ref}".`);
    return textResult(formatSnapshot(snap));
  }
});

const fileUpload = defineTool({
  schema: {
    name: "browser_file_upload",
    title: "Browser File Upload",
    description: "Upload one or multiple files",
    inputSchema: z.object({
      ref: z.string().optional().describe(
        "File input element reference from the page snapshot, or a unique CSS selector. If omitted, an active file chooser is expected."
      ),
      paths: z.array(z.string()).optional().describe("The absolute paths to the files to upload. Can be single file or multiple files. If omitted, file chooser is cancelled.")
    })
  },
  handle: async (args, runtime) => {
    if (!args.ref) {
      throw new Error("A file input ref is required in this implementation.");
    }
    const snap = await runtime.uploadFile(args.ref, args.paths ?? []);
    if (!snap) return textResult(`Uploaded ${args.paths?.length ?? 0} file(s) to "${args.ref}".`);
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

export default [selectOption, check, fileUpload, fillForm, drop];
