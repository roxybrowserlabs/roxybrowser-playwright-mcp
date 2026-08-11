import { writeFile } from "node:fs/promises";
import { extname } from "node:path";
import { z } from "zod";
import { defineTabTool } from "./tool.js";

const screenshot = defineTabTool({
  capability: "core",
  schema: {
    name: "browser_take_screenshot",
    title: "Take a screenshot",
    description: "Take a screenshot of the current page. You can't perform actions based on the screenshot, use browser_snapshot for actions.",
    inputSchema: z.object({
      element: z.string().optional().describe("Human-readable description of the area to screenshot"),
      target: z.string().optional().describe("Element reference or CSS selector to clip screenshot to; omit for full page"),
      type: z.enum(["png", "jpeg", "webp"]).optional().describe("Image format for the screenshot. If unset, inferred from the filename extension, otherwise png."),
      filename: z.string().optional().describe("File name to save the screenshot to. Defaults to `page-{timestamp}.{png|jpeg|webp}` if not specified. Prefer relative file names to stay within the output directory."),
      fullPage: z.boolean().optional().describe("When true, takes a screenshot of the full scrollable page, instead of the currently visible viewport. Cannot be used with element screenshots."),
      scale: z.enum(["css", "device"]).default("css").describe("Image resolution scale. \"css\" produces a screenshot sized in CSS pixels (smaller, consistent across devices). \"device\" produces a high-resolution screenshot using device pixels (larger, accounts for the device pixel ratio). Default is css.")
    }),
    type: "readOnly"
  },
  handle: async (tab, args, response) => {
    if (args.fullPage && args.target) {
      throw new Error("fullPage cannot be used with element screenshots.");
    }
    const requestedFilename = args.filename?.trim();
    const type = args.type ?? inferScreenshotTypeFromFilename(requestedFilename) ?? "png";
    const quality = type === "jpeg" ? 90 : undefined;
    const target = args.target
      ? await tab.targetLocator({ target: args.target, element: args.element })
      : undefined;
    const screenshotTargetLabel = target
      ? args.element || "element"
      : args.fullPage ? "full page" : "viewport";
    const result = await tab.takeScreenshot({
      type,
      ...(quality !== undefined ? { quality } : {}),
      ...(args.fullPage !== undefined ? { fullPage: args.fullPage } : {}),
      scale: args.scale,
      ...(args.target !== undefined ? { target: args.target } : {})
    });
    const autoFilenamePrefix = target ? "element" : "page";
    const resolvedFilename = await tab.context.resolveOutputFile(
      requestedFilename || `${autoFilenamePrefix}-${new Date().toISOString().replace(/[:.]/g, "-")}.${type}`,
      "screenshot"
    );
    await writeFile(resolvedFilename, Buffer.from(result.data, "base64"));
    tab.context.markWrittenFile(resolvedFilename);
    response.addCode(`// Screenshot ${screenshotTargetLabel} and save it as ${resolvedFilename}`);
    if (target) {
      response.addCode(`await page.${target.resolved}.screenshot(${formatScreenshotCodeOptions({
        type,
        ...(quality !== undefined ? { quality } : {}),
        scale: args.scale,
        path: resolvedFilename
      })});`);
    } else {
      response.addCode(`await page.screenshot(${formatScreenshotCodeOptions({
        type,
        ...(quality !== undefined ? { quality } : {}),
        scale: args.scale,
        ...(args.fullPage !== undefined ? { fullPage: args.fullPage } : {}),
        path: resolvedFilename
      })});`);
    }
    if (requestedFilename) {
      response.addTextResult(`Screenshot saved to "${resolvedFilename}".`);
      return;
    }
    response.addTextResult(resolvedFilename);
    response.addImageResult(result.data, result.mimeType);
  }
});

function inferScreenshotTypeFromFilename(filename?: string): "png" | "jpeg" | "webp" | undefined {
  if (!filename) {
    return undefined;
  }
  const extension = extname(filename).toLowerCase();
  if (extension === ".jpg" || extension === ".jpeg") {
    return "jpeg";
  }
  if (extension === ".png") {
    return "png";
  }
  if (extension === ".webp") {
    return "webp";
  }
  return undefined;
}

function formatScreenshotCodeOptions(options: {
  type: "png" | "jpeg" | "webp";
  quality?: number;
  scale?: "css" | "device";
  fullPage?: boolean;
  path: string;
}): string {
  const entries = [
    `type: '${options.type}'`,
    ...(options.quality !== undefined ? [`quality: ${String(options.quality)}`] : []),
    ...(options.scale !== undefined ? [`scale: '${options.scale}'`] : []),
    ...(options.fullPage !== undefined ? [`fullPage: ${String(options.fullPage)}`] : []),
    `path: '${options.path.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`
  ];
  return `{ ${entries.join(", ")} }`;
}

export default [screenshot];
