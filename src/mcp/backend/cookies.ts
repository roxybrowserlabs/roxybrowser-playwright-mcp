import * as z from "zod";
import { defineTool } from "./tool.js";

const cookieList = defineTool({
  capability: "storage",

  schema: {
    name: "browser_cookie_list",
    title: "List cookies",
    description: "List all cookies (optionally filtered by domain/path)",
    inputSchema: z.object({
      domain: z.string().optional().describe("Filter cookies by domain"),
      path: z.string().optional().describe("Filter cookies by path")
    }),
    type: "readOnly"
  },

  handle: async (context, params, response) => {
    let cookies = await context.runtime.cookies();

    if (params.domain) {
      cookies = cookies.filter((cookie) => cookie.domain.includes(params.domain!));
    }
    if (params.path) {
      cookies = cookies.filter((cookie) => cookie.path.startsWith(params.path!));
    }

    if (cookies.length === 0) {
      response.addTextResult("No cookies found");
    } else {
      response.addTextResult(
        cookies.map((cookie) => `${cookie.name}=${cookie.value} (domain: ${cookie.domain}, path: ${cookie.path})`).join("\n")
      );
    }
    response.addCode("await page.context().cookies();");
  }
});

const cookieGet = defineTool({
  capability: "storage",

  schema: {
    name: "browser_cookie_get",
    title: "Get cookie",
    description: "Get a specific cookie by name",
    inputSchema: z.object({
      name: z.string().describe("Cookie name to get")
    }),
    type: "readOnly"
  },

  handle: async (context, params, response) => {
    const cookies = await context.runtime.cookies();
    const cookie = cookies.find((candidate) => candidate.name === params.name);

    if (!cookie) {
      response.addTextResult(`Cookie '${params.name}' not found`);
    } else {
      response.addTextResult(
        `${cookie.name}=${cookie.value} (domain: ${cookie.domain}, path: ${cookie.path}, httpOnly: ${cookie.httpOnly}, secure: ${cookie.secure}, sameSite: ${cookie.sameSite})`
      );
    }
    response.addCode("await page.context().cookies();");
  }
});

const cookieSet = defineTool({
  capability: "storage",

  schema: {
    name: "browser_cookie_set",
    title: "Set cookie",
    description: "Set a cookie with optional flags (domain, path, expires, httpOnly, secure, sameSite)",
    inputSchema: z.object({
      name: z.string().describe("Cookie name"),
      value: z.string().describe("Cookie value"),
      domain: z.string().optional().describe("Cookie domain"),
      path: z.string().optional().describe("Cookie path"),
      expires: z.number().optional().describe("Cookie expiration as Unix timestamp"),
      httpOnly: z.boolean().optional().describe("Whether the cookie is HTTP only"),
      secure: z.boolean().optional().describe("Whether the cookie is secure"),
      sameSite: z.enum(["Strict", "Lax", "None"]).optional().describe("Cookie SameSite attribute")
    }),
    type: "action"
  },

  handle: async (context, params, response) => {
    await context.ensureTab();
    const url = new URL(context.runtime.requireActiveTab().url);
    const cookie = {
      name: params.name,
      value: params.value,
      domain: params.domain || url.hostname,
      path: params.path || "/",
      ...(params.expires !== undefined ? { expires: params.expires } : {}),
      ...(params.httpOnly !== undefined ? { httpOnly: params.httpOnly } : {}),
      ...(params.secure !== undefined ? { secure: params.secure } : {}),
      ...(params.sameSite !== undefined ? { sameSite: params.sameSite } : {})
    };

    await context.runtime.addCookies([cookie]);
    response.addCode(`await page.context().addCookies([${JSON.stringify(cookie)}]);`);
  }
});

const cookieDelete = defineTool({
  capability: "storage",

  schema: {
    name: "browser_cookie_delete",
    title: "Delete cookie",
    description: "Delete a specific cookie",
    inputSchema: z.object({
      name: z.string().describe("Cookie name to delete")
    }),
    type: "action"
  },

  handle: async (context, params, response) => {
    await context.runtime.clearCookies({ name: params.name });
    response.addCode(`await page.context().clearCookies({ name: '${params.name}' });`);
  }
});

const cookieClear = defineTool({
  capability: "storage",

  schema: {
    name: "browser_cookie_clear",
    title: "Clear cookies",
    description: "Clear all cookies",
    inputSchema: z.object({}),
    type: "action"
  },

  handle: async (context, _params, response) => {
    await context.runtime.clearCookies();
    response.addCode("await page.context().clearCookies();");
  }
});

export default [
  cookieList,
  cookieGet,
  cookieSet,
  cookieDelete,
  cookieClear
];
