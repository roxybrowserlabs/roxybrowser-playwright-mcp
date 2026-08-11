import * as z from "zod";
import type { BrowserCookieInput, BrowserStorageItem, BrowserStorageState } from "../types.js";
import { defineTool } from "./tool.js";

const storageState = defineTool({
  capability: "storage",

  schema: {
    name: "browser_storage_state",
    title: "Save storage state",
    description: "Save storage state (cookies, local storage) to a file for later reuse",
    inputSchema: z.object({
      filename: z.string().optional().describe("File name to save the storage state to. Defaults to `storage-state-{timestamp}.json` if not specified.")
    }),
    type: "readOnly"
  },

  handle: async (context, params, response) => {
    const state = await context.runtime.storageState();
    const serializedState = JSON.stringify(state, null, 2);
    const filename = params.filename ?? `storage-state-${Date.now()}.json`;
    const resolvedFilename = await context.resolveOutputFile(filename, "storage");
    await context.writeTextFile(resolvedFilename, serializedState);
    response.addTextResult(`- [Storage state](${resolvedFilename})`);
    response.addCode(`await page.context().storageState({ path: '${filename}' });`);
  }
});

const setStorageState = defineTool({
  capability: "storage",

  schema: {
    name: "browser_set_storage_state",
    title: "Restore storage state",
    description: "Restore storage state (cookies, local storage) from a file. This clears existing cookies and local storage before restoring.",
    inputSchema: z.object({
      filename: z.string().describe("Path to the storage state file to restore from")
    }),
    type: "action"
  },

  handle: async (context, params, response) => {
    const resolvedFilename = context.resolveInputFile(params.filename, "storage");
    const state = parseStorageState(await context.readTextFile(resolvedFilename));
    await context.runtime.setStorageState(state);
    response.addTextResult(`Storage state restored from ${params.filename}`);
    response.addCode(`await page.context().setStorageState('${params.filename}');`);
  }
});

export default [
  storageState,
  setStorageState
];

function parseStorageState(text: string): BrowserStorageState {
  const parsed: unknown = JSON.parse(text);
  if (!isStorageState(parsed)) {
    throw new Error("Invalid storage state file.");
  }
  return parsed;
}

function isStorageState(value: unknown): value is BrowserStorageState {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<BrowserStorageState>;
  return Array.isArray(candidate.cookies)
    && candidate.cookies.every(isBrowserCookie)
    && Array.isArray(candidate.origins)
    && candidate.origins.every(isStorageOrigin);
}

function isBrowserCookie(value: unknown): value is BrowserCookieInput {
  if (!value || typeof value !== "object") {
    return false;
  }
  const cookie = value as Partial<BrowserCookieInput>;
  return typeof cookie.name === "string"
    && typeof cookie.value === "string"
    && (cookie.url === undefined || typeof cookie.url === "string")
    && (cookie.domain === undefined || typeof cookie.domain === "string")
    && (cookie.path === undefined || typeof cookie.path === "string")
    && (cookie.expires === undefined || typeof cookie.expires === "number")
    && (cookie.httpOnly === undefined || typeof cookie.httpOnly === "boolean")
    && (cookie.secure === undefined || typeof cookie.secure === "boolean")
    && (cookie.sameSite === undefined || cookie.sameSite === "Strict" || cookie.sameSite === "Lax" || cookie.sameSite === "None")
    && (cookie.partitionKey === undefined || typeof cookie.partitionKey === "string");
}

function isStorageOrigin(value: unknown): value is BrowserStorageState["origins"][number] {
  if (!value || typeof value !== "object") {
    return false;
  }
  const origin = value as Partial<BrowserStorageState["origins"][number]>;
  return typeof origin.origin === "string"
    && Array.isArray(origin.localStorage)
    && origin.localStorage.every(isStorageItem);
}

function isStorageItem(value: unknown): value is BrowserStorageItem {
  if (!value || typeof value !== "object") {
    return false;
  }
  const item = value as Partial<BrowserStorageItem>;
  return typeof item.name === "string" && typeof item.value === "string";
}
