import { extname } from "node:path";
import type { Rect, ScreenshotOptions, ScreenshotType } from "./types/options.js";

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
