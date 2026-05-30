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

export type RoxyBrowserConnectInput = z.infer<typeof roxyBrowserConnectSchema>;
export type BrowserTabsInput = z.infer<typeof browserTabsSchema>;
export type BrowserSnapshotInput = z.infer<typeof browserSnapshotSchema>;
export type BrowserRefActionInput = z.infer<typeof browserRefActionSchema>;
