import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, join, relative, resolve } from "node:path";
import type { ElementHandle } from "./types/api.js";
import type { FilePayload } from "./types/options.js";

const fileUploadSizeLimit = 50 * 1024 * 1024;

export type InputFiles = string | FilePayload | string[] | FilePayload[];

export interface FileUploadPayload {
  base64: string;
  lastModifiedMs?: number;
  mimeType: string;
  name: string;
  webkitRelativePath?: string;
}

export interface ResolvedInputFiles {
  directoryUpload: boolean;
  multiple: boolean;
  payloads: FileUploadPayload[];
}

export async function setInputFilesOnElement(
  handle: ElementHandle,
  files: InputFiles
): Promise<void> {
  const resolved = await convertInputFiles(files);
  await handle.evaluate(
    (element, inputFiles) => {
      const input = element instanceof HTMLInputElement
        ? element
        : element instanceof HTMLLabelElement
          ? element.control
          : null;
      if (!(input instanceof HTMLInputElement)) {
        throw new Error("Node is not an HTMLInputElement");
      }
      if (input.type !== "file") {
        throw new Error("Node is not an HTMLInputElement");
      }
      if (inputFiles.multiple && !input.multiple && !input.webkitdirectory) {
        throw new Error("Non-multiple file input can only accept single file");
      }
      if (inputFiles.directoryUpload && !input.webkitdirectory) {
        throw new Error("File input does not support directories, pass individual files instead");
      }
      if (!inputFiles.directoryUpload && input.webkitdirectory) {
        throw new Error("[webkitdirectory] input requires passing a path to a directory");
      }

      const dataTransfer = new DataTransfer();
      for (const payload of inputFiles.payloads) {
        const bytes = Uint8Array.from(atob(payload.base64), (char) => char.charCodeAt(0));
        const fileOptions: FilePropertyBag = { type: payload.mimeType || "application/octet-stream" };
        if (payload.lastModifiedMs !== undefined) {
          fileOptions.lastModified = payload.lastModifiedMs;
        }
        const file = new File([bytes], payload.name, fileOptions);
        if (payload.webkitRelativePath) {
          Object.defineProperty(file, "webkitRelativePath", {
            configurable: true,
            value: payload.webkitRelativePath
          });
        }
        dataTransfer.items.add(file);
      }
      input.files = dataTransfer.files;
      input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    },
    resolved
  );
}

export async function convertInputFiles(files: InputFiles): Promise<ResolvedInputFiles> {
  const items = Array.isArray(files) ? [...files] : [files];
  if (items.some((item) => typeof item === "string")) {
    if (!items.every((item) => typeof item === "string")) {
      throw new Error("File paths cannot be mixed with buffers");
    }
    const { localDirectory, localPaths } = await resolvePathsAndDirectoryForInputFiles(items);
    if (localDirectory) {
      const payloads = await payloadsForDirectory(localDirectory);
      return {
        directoryUpload: true,
        multiple: payloads.length > 1,
        payloads
      };
    }
    const payloads = await Promise.all((localPaths ?? []).map(payloadForPath));
    return {
      directoryUpload: false,
      multiple: payloads.length > 1,
      payloads
    };
  }

  const payloads = items as FilePayload[];
  if (filePayloadExceedsSizeLimit(payloads)) {
    throw new Error("Cannot set buffer larger than 50Mb, please write it to a file and pass its path instead.");
  }
  return {
    directoryUpload: false,
    multiple: payloads.length > 1,
    payloads: payloads.map((payload) => ({
      base64: payload.buffer.toString("base64"),
      mimeType: payload.mimeType || "application/octet-stream",
      name: payload.name
    }))
  };
}

async function resolvePathsAndDirectoryForInputFiles(items: string[]): Promise<{
  localDirectory?: string;
  localPaths?: string[];
}> {
  let localDirectory: string | undefined;
  const localPaths: string[] = [];
  for (const item of items) {
    const resolved = resolve(item);
    const fileStat = await stat(resolved);
    if (fileStat.isDirectory()) {
      if (localDirectory) {
        throw new Error("Multiple directories are not supported");
      }
      localDirectory = resolved;
    } else {
      localPaths.push(resolved);
    }
  }
  if (localPaths.length && localDirectory) {
    throw new Error("File paths must be all files or a single directory");
  }
  return {
    ...(localDirectory ? { localDirectory } : {}),
    ...(localPaths.length ? { localPaths } : {})
  };
}

async function payloadsForDirectory(localDirectory: string): Promise<FileUploadPayload[]> {
  const filePaths = await collectFiles(localDirectory);
  const rootName = basename(localDirectory);
  return Promise.all(filePaths.map(async (filePath) => {
    const payload = await payloadForPath(filePath);
    return {
      ...payload,
      webkitRelativePath: join(rootName, relative(localDirectory, filePath)).replace(/\\/g, "/")
    };
  }));
}

async function collectFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectFiles(entryPath));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }
  return files;
}

async function payloadForPath(filePath: string): Promise<FileUploadPayload> {
  const [buffer, fileStat] = await Promise.all([
    readFile(filePath),
    stat(filePath)
  ]);
  return {
    base64: buffer.toString("base64"),
    lastModifiedMs: fileStat.mtimeMs,
    mimeType: inferMimeType(filePath),
    name: basename(filePath)
  };
}

function filePayloadExceedsSizeLimit(payloads: FilePayload[]): boolean {
  return payloads.reduce((size, item) => size + item.buffer.byteLength, 0) >= fileUploadSizeLimit;
}

function inferMimeType(filePath: string): string {
  const extension = extname(filePath).toLowerCase();
  switch (extension) {
    case ".avif":
      return "image/avif";
    case ".bmp":
      return "image/bmp";
    case ".css":
      return "text/css";
    case ".csv":
      return "text/csv";
    case ".gif":
      return "image/gif";
    case ".htm":
    case ".html":
      return "text/html";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".js":
    case ".mjs":
      return "text/javascript";
    case ".json":
      return "application/json";
    case ".md":
      return "text/markdown";
    case ".pdf":
      return "application/pdf";
    case ".png":
      return "image/png";
    case ".svg":
      return "image/svg+xml";
    case ".txt":
      return "text/plain";
    case ".webp":
      return "image/webp";
    case ".xml":
      return "application/xml";
    case ".zip":
      return "application/zip";
    default:
      return "application/octet-stream";
  }
}
