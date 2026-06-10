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
    description: "Set files on a file input element. Only supported over CDP; throws for BiDi connections.",
    inputSchema: z.object({
      element: z.string().optional().describe(
        "Human-readable element description used to obtain permission"
      ),
      ref: z.string().describe(
        "File input element reference from the page snapshot, or a unique CSS selector"
      ),
      paths: z.array(z.string()).describe("Absolute file paths to upload")
    })
  },
  handle: async (args, runtime) => {
    const snap = await runtime.uploadFile(args.ref, args.paths);
    if (!snap) return textResult(`Uploaded ${args.paths.length} file(s) to "${args.element ?? args.ref}".`);
    return textResult(formatSnapshot(snap));
  }
});

export default [selectOption, check, fileUpload];
