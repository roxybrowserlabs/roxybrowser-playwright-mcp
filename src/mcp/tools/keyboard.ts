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
      ref: z.string().describe(
        "Exact element reference from the page snapshot, or a unique CSS selector"
      ),
      text: z.string().describe("Text to type into the element"),
      submit: z.boolean().optional().describe("Press Enter after typing")
    })
  },
  handle: async (args, runtime) => {
    const snap = await runtime.type(args.ref, args.text, {
      ...(args.submit !== undefined ? { submit: args.submit } : {})
    });
    if (!snap) return textResult(`Typed into "${args.element ?? args.ref}".`);
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
      ),
      modifiers: z.array(z.enum(["Alt", "Control", "ControlOrMeta", "Meta", "Shift"])).optional()
    })
  },
  handle: async (args, runtime) => {
    const snap = await runtime.pressKey(args.key, args.modifiers);
    if (!snap) return textResult(`Pressed key "${args.key}".`);
    return textResult(formatSnapshot(snap));
  }
});

export default [type, pressKey];
