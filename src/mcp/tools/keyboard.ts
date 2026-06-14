import { z } from "zod";
import { defineTool, textResult } from "../tool.js";
import { formatSnapshot } from "../format.js";

const type = defineTool({
  schema: {
    name: "browser_type",
    title: "Browser Type",
    description: "Type text into an element. Returns an updated snapshot after typing.",
    inputSchema: z.object({
      element: z.string().optional().describe(
        "Human-readable element description used to obtain permission"
      ),
      target: z.string().describe(
        "Exact target element reference from the page snapshot, or a unique element selector"
      ),
      text: z.string().describe("Text to type into the element"),
      submit: z.boolean().optional().describe("Whether to submit entered text (press Enter after)"),
      slowly: z.boolean().optional().describe("Whether to type one character at a time. Useful for triggering key handlers in the page. By default entire text is filled in at once.")
    })
  },
  handle: async (args, runtime) => {
    const snap = await runtime.type(args.target, args.text, {
      ...(args.submit !== undefined ? { submit: args.submit } : {}),
      ...(args.slowly !== undefined ? { slowly: args.slowly } : {})
    });
    if (!snap) return textResult(`Typed into "${args.element ?? args.target}".`);
    return textResult(formatSnapshot(snap));
  }
});

const pressKey = defineTool({
  schema: {
    name: "browser_press_key",
    title: "Browser Press Key",
    description: "Press a keyboard key, optionally with modifier keys. Returns an updated snapshot.",
    inputSchema: z.object({
      key: z.string().describe(
        "Key to press, e.g. Enter, Escape, Tab, ArrowLeft, Backspace, Delete, or printable characters"
      )
    })
  },
  handle: async (args, runtime) => {
    const snap = await runtime.pressKey(args.key);
    if (!snap) return textResult(`Pressed key "${args.key}".`);
    return textResult(formatSnapshot(snap));
  }
});

export default [];
