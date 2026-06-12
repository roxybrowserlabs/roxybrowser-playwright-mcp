import { z } from "zod";
import { defineTool, textResult } from "../tool.js";
import { formatSnapshot } from "../format.js";

const click = defineTool({
  schema: {
    name: "browser_click",
    title: "Browser Click",
    description: "Perform click on a web page. Returns an updated snapshot.",
    inputSchema: z.object({
      element: z.string().optional().describe(
        "Human-readable element description used to obtain permission to interact with the element"
      ),
      target: z.string().describe(
        "Exact target element reference from the page snapshot, or a unique CSS selector"
      ),
      doubleClick: z.boolean().optional().describe(
        "Whether to perform a double click instead of a single click"
      ),
      button: z.enum(["left", "right", "middle"]).optional().describe(
        "Button to click, defaults to left"
      ),
      modifiers: z.array(z.enum(["Alt", "Control", "ControlOrMeta", "Meta", "Shift"])).optional().describe(
        "Modifier keys to press during the click"
      ),
      human: z.object({
        profile: z.enum(["cautious", "balanced", "fast"]).optional().describe(
          "Humanization timing profile, defaults to balanced"
        )
      }).optional().describe("Humanization settings for this click")
    })
  },
  handle: async (args, runtime) => {
    const snap = await runtime.click(args.target, {
      ...(args.element !== undefined ? { element: args.element } : {}),
      ...(args.doubleClick !== undefined ? { doubleClick: args.doubleClick } : {}),
      ...(args.button !== undefined ? { button: args.button } : {}),
      ...(args.modifiers !== undefined ? { modifiers: args.modifiers } : {}),
      ...(args.human !== undefined ? { human: args.human as { profile?: string } } : {})
    });
    if (!snap) return textResult(`Clicked "${args.element ?? args.target}".`);
    return textResult(formatSnapshot(snap));
  }
});

const hover = defineTool({
  schema: {
    name: "browser_hover",
    title: "Browser Hover",
    description: "Hover a previously snapshotted element reference in the active tab.",
    inputSchema: z.object({
      ref: z.string().min(1)
    })
  },
  handle: async (args, runtime) => {
    await runtime.hover(args.ref);
    return textResult(`Hovered ref "${args.ref}".`);
  }
});

const drag = defineTool({
  schema: {
    name: "browser_drag",
    title: "Drag mouse",
    description: "Perform drag and drop between two elements",
    inputSchema: z.object({
      startElement: z.string().optional().describe("Human-readable source element description used to obtain the permission to interact with the element"),
      startTarget: z.string().describe("Exact target element reference from the page snapshot, or a unique element selector"),
      endElement: z.string().optional().describe("Human-readable target element description used to obtain the permission to interact with the element"),
      endTarget: z.string().describe("Exact target element reference from the page snapshot, or a unique element selector")
    })
  },
  handle: async (args, runtime) => {
    const snap = await runtime.drag(args.startTarget, args.endTarget);
    if (!snap) return textResult(`Dragged "${args.startElement ?? args.startTarget}" to "${args.endElement ?? args.endTarget}".`);
    return textResult(formatSnapshot(snap));
  }
});

const scroll = defineTool({
  schema: {
    name: "browser_scroll",
    title: "Browser Scroll",
    description: "Scroll the page or a specific element. Returns an updated snapshot.",
    inputSchema: z.object({
      element: z.string().optional().describe(
        "Human-readable element description used to obtain permission"
      ),
      ref: z.string().optional().describe(
        "Element to scroll; omit to scroll the whole page"
      ),
      deltaX: z.number().optional().describe("Horizontal scroll delta in pixels (default 0)"),
      deltaY: z.number().optional().describe("Vertical scroll delta in pixels (default 0)")
    })
  },
  handle: async (args, runtime) => {
    const snap = await runtime.scroll(args.ref ?? null, args.deltaX ?? 0, args.deltaY ?? 0);
    if (!snap) return textResult("Scrolled.");
    return textResult(formatSnapshot(snap));
  }
});

export default [click, drag, hover, scroll];
