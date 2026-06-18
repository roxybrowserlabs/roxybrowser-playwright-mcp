import { extname } from "node:path";
import type { ScreenshotClipOrigin } from "./protocol/adapter.js";
import type { Rect, ScreenshotOptions, ScreenshotType, ViewportSize } from "./types/options.js";

export type InternalScreenshotOptions = ScreenshotOptions & {
  __fitsViewport?: boolean;
};

export interface NormalizedScreenshot {
  fitsViewport: boolean;
  options: InternalScreenshotOptions;
}

export function determineScreenshotType(options: { path?: string; type?: ScreenshotType }): ScreenshotType | undefined {
  if (options.type) {
    return options.type;
  }
  if (!options.path) {
    return undefined;
  }

  const mimeType = getMimeTypeForPath(options.path);
  if (mimeType === "image/png") {
    return "png";
  }
  if (mimeType === "image/jpeg") {
    return "jpeg";
  }
  throw new Error(`path: unsupported mime type "${mimeType}"`);
}

export function validateScreenshotOptions(options: ScreenshotOptions): "jpeg" | "png" {
  const format = options.type ?? "png";
  if (format !== "png" && format !== "jpeg") {
    throw new Error(`Unknown options.type value: ${format}`);
  }

  if (options.quality !== undefined) {
    if (format !== "jpeg") {
      throw new Error(`options.quality is unsupported for the ${format} screenshots`);
    }
    if (typeof options.quality !== "number") {
      throw new Error(`Expected options.quality to be a number but found ${typeof options.quality}`);
    }
    if (!Number.isInteger(options.quality)) {
      throw new Error("Expected options.quality to be an integer");
    }
    if (options.quality < 0 || options.quality > 100) {
      throw new Error(`Expected options.quality to be between 0 and 100 (inclusive), got ${options.quality}`);
    }
  }

  if (options.clip) {
    validateClip(options.clip);
  }
  return format;
}

export function trimClipToSize(clip: Rect, size: ViewportSize): Rect {
  const p1 = {
    x: Math.max(0, Math.min(clip.x, size.width)),
    y: Math.max(0, Math.min(clip.y, size.height))
  };
  const p2 = {
    x: Math.max(0, Math.min(clip.x + clip.width, size.width)),
    y: Math.max(0, Math.min(clip.y + clip.height, size.height))
  };
  const result = { x: p1.x, y: p1.y, width: p2.x - p1.x, height: p2.y - p1.y };
  if (!result.width || !result.height) {
    throw new Error("Clipped area is either empty or outside the resulting image");
  }
  return result;
}

export async function normalizePageScreenshotOptions(
  options: ScreenshotOptions,
  page: {
    evaluate<R, Arg>(pageFunction: (arg: Arg) => R | Promise<R>, arg: Arg): Promise<R>;
    evaluate<R>(pageFunction: () => R | Promise<R>, arg?: any): Promise<R>;
    viewportSize(): ViewportSize | null;
  },
  clipOrigin: ScreenshotClipOrigin = "document"
): Promise<NormalizedScreenshot> {
  const screenshotOptions: InternalScreenshotOptions = { ...options };
  const viewportSize = page.viewportSize()
    ?? await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));

  if (options.fullPage) {
    const evaluatedFullPageSize = await page.evaluate(() => {
      if (!document.body || !document.documentElement) {
        return { width: window.innerWidth, height: window.innerHeight };
      }
      return {
        width: Math.max(
          document.body.scrollWidth,
          document.documentElement.scrollWidth,
          document.body.offsetWidth,
          document.documentElement.offsetWidth,
          document.body.clientWidth,
          document.documentElement.clientWidth
        ),
        height: Math.max(
          document.body.scrollHeight,
          document.documentElement.scrollHeight,
          document.body.offsetHeight,
          document.documentElement.offsetHeight,
          document.body.clientHeight,
          document.documentElement.clientHeight
        )
      };
    });
    const fullPageSize = isSize(evaluatedFullPageSize) ? evaluatedFullPageSize : viewportSize;
    const fitsViewport = fullPageSize.width <= viewportSize.width && fullPageSize.height <= viewportSize.height;
    screenshotOptions.clip = options.clip
      ? trimClipToSize(options.clip, fullPageSize)
      : { x: 0, y: 0, width: fullPageSize.width, height: fullPageSize.height };
    screenshotOptions.__fitsViewport = fitsViewport;
    return { fitsViewport, options: screenshotOptions };
  }

  const viewportClip = options.clip
    ? trimClipToSize(options.clip, viewportSize)
    : { x: 0, y: 0, width: viewportSize.width, height: viewportSize.height };
  const scrollOffset = clipOrigin === "document"
    ? await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }))
    : { x: 0, y: 0 };
  const normalizedScrollOffset = isPoint(scrollOffset) ? scrollOffset : { x: 0, y: 0 };
  screenshotOptions.clip = {
    x: normalizedScrollOffset.x + viewportClip.x,
    y: normalizedScrollOffset.y + viewportClip.y,
    width: viewportClip.width,
    height: viewportClip.height
  };
  screenshotOptions.__fitsViewport = true;
  return { fitsViewport: true, options: screenshotOptions };
}

export function screenshotOptionsWithFitsViewport(
  options: ScreenshotOptions,
  fitsViewport: boolean
): InternalScreenshotOptions {
  return {
    ...options,
    __fitsViewport: fitsViewport
  };
}

export async function normalizeElementScreenshotClip(
  box: Rect,
  element: {
    evaluate<R>(pageFunction: () => R | Promise<R>, arg?: any): Promise<R>;
  },
  clipOrigin: ScreenshotClipOrigin = "document"
): Promise<Rect> {
  const scrollOffset = clipOrigin === "document"
    ? await element.evaluate(() => ({ x: window.scrollX, y: window.scrollY }))
    : { x: 0, y: 0 };
  const normalizedScrollOffset = isPoint(scrollOffset) ? scrollOffset : { x: 0, y: 0 };
  return enclosingIntRect({
    x: box.x + normalizedScrollOffset.x,
    y: box.y + normalizedScrollOffset.y,
    width: box.width,
    height: box.height
  });
}

export function enclosingIntRect(rect: Rect): Rect {
  const x = Math.floor(rect.x);
  const y = Math.floor(rect.y);
  const right = Math.ceil(rect.x + rect.width);
  const bottom = Math.ceil(rect.y + rect.height);
  return {
    x,
    y,
    width: right - x,
    height: bottom - y
  };
}

function isPoint(value: unknown): value is { x: number; y: number } {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof (value as { x?: unknown }).x === "number" &&
    typeof (value as { y?: unknown }).y === "number"
  );
}

function isSize(value: unknown): value is ViewportSize {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof (value as { width?: unknown }).width === "number" &&
    typeof (value as { height?: unknown }).height === "number"
  );
}

function validateClip(clip: Rect): void {
  if (typeof clip.x !== "number") {
    throw new Error(`Expected options.clip.x to be a number but found ${typeof clip.x}`);
  }
  if (typeof clip.y !== "number") {
    throw new Error(`Expected options.clip.y to be a number but found ${typeof clip.y}`);
  }
  if (typeof clip.width !== "number") {
    throw new Error(`Expected options.clip.width to be a number but found ${typeof clip.width}`);
  }
  if (typeof clip.height !== "number") {
    throw new Error(`Expected options.clip.height to be a number but found ${typeof clip.height}`);
  }
  if (clip.width === 0) {
    throw new Error("Expected options.clip.width not to be 0.");
  }
  if (clip.height === 0) {
    throw new Error("Expected options.clip.height not to be 0.");
  }
}

function getMimeTypeForPath(path: string): string {
  const extension = extname(path).toLowerCase();
  switch (extension) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".txt":
      return "text/plain";
    default:
      return "application/octet-stream";
  }
}
