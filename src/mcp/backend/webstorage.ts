import * as z from "zod";
import { defineTool } from "./tool.js";

const localStorageList = defineTool({
  capability: "storage",

  schema: {
    name: "browser_localstorage_list",
    title: "List localStorage",
    description: "List all localStorage key-value pairs",
    inputSchema: z.object({}),
    type: "readOnly"
  },

  handle: async (context, _params, response) => {
    await context.ensureTab();
    const items = await context.runtime.webStorageItems("localStorage");

    if (items.length === 0) {
      response.addTextResult("No localStorage items found");
    } else {
      response.addTextResult(items.map((item) => `${item.name}=${item.value}`).join("\n"));
    }
    response.addCode("await page.localStorage.items();");
  }
});

const localStorageGet = defineTool({
  capability: "storage",

  schema: {
    name: "browser_localstorage_get",
    title: "Get localStorage item",
    description: "Get a localStorage item by key",
    inputSchema: z.object({
      key: z.string().describe("Key to get")
    }),
    type: "readOnly"
  },

  handle: async (context, params, response) => {
    await context.ensureTab();
    const items = await context.runtime.webStorageItems("localStorage");
    const value = items.find((item) => item.name === params.key)?.value ?? null;

    if (value === null) {
      response.addTextResult(`localStorage key '${params.key}' not found`);
    } else {
      response.addTextResult(`${params.key}=${value}`);
    }
    response.addCode(`await page.localStorage.getItem('${params.key}');`);
  }
});

const localStorageSet = defineTool({
  capability: "storage",

  schema: {
    name: "browser_localstorage_set",
    title: "Set localStorage item",
    description: "Set a localStorage item",
    inputSchema: z.object({
      key: z.string().describe("Key to set"),
      value: z.string().describe("Value to set")
    }),
    type: "action"
  },

  handle: async (context, params, response) => {
    await context.ensureTab();
    await context.runtime.setWebStorageItem("localStorage", params.key, params.value);
    response.addCode(`await page.localStorage.setItem('${params.key}', '${params.value}');`);
  }
});

const localStorageDelete = defineTool({
  capability: "storage",

  schema: {
    name: "browser_localstorage_delete",
    title: "Delete localStorage item",
    description: "Delete a localStorage item",
    inputSchema: z.object({
      key: z.string().describe("Key to delete")
    }),
    type: "action"
  },

  handle: async (context, params, response) => {
    await context.ensureTab();
    await context.runtime.removeWebStorageItem("localStorage", params.key);
    response.addCode(`await page.localStorage.removeItem('${params.key}');`);
  }
});

const localStorageClear = defineTool({
  capability: "storage",

  schema: {
    name: "browser_localstorage_clear",
    title: "Clear localStorage",
    description: "Clear all localStorage",
    inputSchema: z.object({}),
    type: "action"
  },

  handle: async (context, _params, response) => {
    await context.ensureTab();
    await context.runtime.clearWebStorage("localStorage");
    response.addCode("await page.localStorage.clear();");
  }
});

const sessionStorageList = defineTool({
  capability: "storage",

  schema: {
    name: "browser_sessionstorage_list",
    title: "List sessionStorage",
    description: "List all sessionStorage key-value pairs",
    inputSchema: z.object({}),
    type: "readOnly"
  },

  handle: async (context, _params, response) => {
    await context.ensureTab();
    const items = await context.runtime.webStorageItems("sessionStorage");

    if (items.length === 0) {
      response.addTextResult("No sessionStorage items found");
    } else {
      response.addTextResult(items.map((item) => `${item.name}=${item.value}`).join("\n"));
    }
    response.addCode("await page.sessionStorage.items();");
  }
});

const sessionStorageGet = defineTool({
  capability: "storage",

  schema: {
    name: "browser_sessionstorage_get",
    title: "Get sessionStorage item",
    description: "Get a sessionStorage item by key",
    inputSchema: z.object({
      key: z.string().describe("Key to get")
    }),
    type: "readOnly"
  },

  handle: async (context, params, response) => {
    await context.ensureTab();
    const items = await context.runtime.webStorageItems("sessionStorage");
    const value = items.find((item) => item.name === params.key)?.value ?? null;

    if (value === null) {
      response.addTextResult(`sessionStorage key '${params.key}' not found`);
    } else {
      response.addTextResult(`${params.key}=${value}`);
    }
    response.addCode(`await page.sessionStorage.getItem('${params.key}');`);
  }
});

const sessionStorageSet = defineTool({
  capability: "storage",

  schema: {
    name: "browser_sessionstorage_set",
    title: "Set sessionStorage item",
    description: "Set a sessionStorage item",
    inputSchema: z.object({
      key: z.string().describe("Key to set"),
      value: z.string().describe("Value to set")
    }),
    type: "action"
  },

  handle: async (context, params, response) => {
    await context.ensureTab();
    await context.runtime.setWebStorageItem("sessionStorage", params.key, params.value);
    response.addCode(`await page.sessionStorage.setItem('${params.key}', '${params.value}');`);
  }
});

const sessionStorageDelete = defineTool({
  capability: "storage",

  schema: {
    name: "browser_sessionstorage_delete",
    title: "Delete sessionStorage item",
    description: "Delete a sessionStorage item",
    inputSchema: z.object({
      key: z.string().describe("Key to delete")
    }),
    type: "action"
  },

  handle: async (context, params, response) => {
    await context.ensureTab();
    await context.runtime.removeWebStorageItem("sessionStorage", params.key);
    response.addCode(`await page.sessionStorage.removeItem('${params.key}');`);
  }
});

const sessionStorageClear = defineTool({
  capability: "storage",

  schema: {
    name: "browser_sessionstorage_clear",
    title: "Clear sessionStorage",
    description: "Clear all sessionStorage",
    inputSchema: z.object({}),
    type: "action"
  },

  handle: async (context, _params, response) => {
    await context.ensureTab();
    await context.runtime.clearWebStorage("sessionStorage");
    response.addCode("await page.sessionStorage.clear();");
  }
});

export default [
  localStorageList,
  localStorageGet,
  localStorageSet,
  localStorageDelete,
  localStorageClear,
  sessionStorageList,
  sessionStorageGet,
  sessionStorageSet,
  sessionStorageDelete,
  sessionStorageClear
];
