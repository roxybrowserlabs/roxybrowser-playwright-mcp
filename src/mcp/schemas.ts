import { z } from "zod";

export const roxyBrowserConnectSchema = z.object({
  protocol: z.enum(["cdp", "bidi"]),
  endpoint: z.string().min(1),
  browser: z.enum(["chromium", "firefox"]).optional()
});

export const browserTabsSchema = z
  .object({
    action: z.enum(["list", "new", "select", "close"]),
    index: z.number().int().nonnegative().optional(),
    url: z.string().url().optional()
  })
  .superRefine((value, context) => {
    if ((value.action === "select" || value.action === "close") && value.index === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `index is required for action "${value.action}".`,
        path: ["index"]
      });
    }
  });

export const browserSnapshotSchema = z.object({
  target: z.string().min(1).optional(),
  filename: z.string().min(1).optional(),
  depth: z.number().optional(),
  boxes: z.boolean().optional()
});

export const browserRefActionSchema = z.object({
  ref: z.string().min(1)
});

export const browserClickSchema = z.object({
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
});

export type RoxyBrowserConnectInput = z.infer<typeof roxyBrowserConnectSchema>;
export type BrowserTabsInput = z.infer<typeof browserTabsSchema>;
export type BrowserSnapshotInput = z.infer<typeof browserSnapshotSchema>;
export type BrowserRefActionInput = z.infer<typeof browserRefActionSchema>;
export type BrowserClickInput = z.infer<typeof browserClickSchema>;
