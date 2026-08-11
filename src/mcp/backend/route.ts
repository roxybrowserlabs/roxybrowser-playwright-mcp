import { z } from "zod";
import { defineTool } from "./tool.js";
import type { BrowserNetworkRoute } from "../types.js";

const route = defineTool({
  capability: "network",
  schema: {
    name: "browser_route",
    title: "Mock network requests",
    description: "Set up a route to mock network requests matching a URL pattern",
    inputSchema: z.object({
      pattern: z.string().describe('URL pattern to match (e.g., "**/api/users", "**/*.{png,jpg}")'),
      status: z.number().optional().describe("HTTP status code to return (default: 200)"),
      body: z.string().optional().describe("Response body (text or JSON string)"),
      contentType: z.string().optional().describe('Content-Type header (e.g., "application/json", "text/html")'),
      headers: z.array(z.string()).optional().describe('Headers to add in "Name: Value" format'),
      removeHeaders: z.string().optional().describe("Comma-separated list of header names to remove from request")
    }),
    type: "action"
  },
  handle: async (context, params, response) => {
    const routeEntry: BrowserNetworkRoute = {
      pattern: params.pattern,
      ...(params.status !== undefined ? { status: params.status } : {}),
      ...(params.body !== undefined ? { body: params.body } : {}),
      ...(params.contentType !== undefined ? { contentType: params.contentType } : {}),
      ...(params.headers !== undefined ? { addHeaders: parseRouteHeaders(params.headers) } : {}),
      ...(params.removeHeaders !== undefined ? { removeHeaders: params.removeHeaders.split(",").map((header) => header.trim()) } : {})
    };

    await context.runtime.addRoute(routeEntry);
    response.addTextResult(`Route added for pattern: ${params.pattern}`);
    response.addCode(`await page.context().route('${params.pattern}', async route => { /* route handler */ });`);
  }
});

const routeList = defineTool({
  capability: "network",
  schema: {
    name: "browser_route_list",
    title: "List network routes",
    description: "List all active network routes",
    inputSchema: z.object({}),
    type: "readOnly"
  },
  handle: async (context, _params, response) => {
    const routes = await context.runtime.routes();
    if (routes.length === 0) {
      response.addTextResult("No active routes");
      return;
    }

    const lines: string[] = [];
    for (let i = 0; i < routes.length; i++) {
      const routeEntry = routes[i];
      if (!routeEntry) {
        continue;
      }
      const details: string[] = [];
      if (routeEntry.abort !== undefined) {
        details.push(`abort=${routeEntry.abort}`);
      }
      if (routeEntry.status !== undefined) {
        details.push(`status=${routeEntry.status}`);
      }
      if (routeEntry.body !== undefined) {
        details.push(`body=${routeEntry.body.length > 50 ? routeEntry.body.substring(0, 50) + "..." : routeEntry.body}`);
      }
      if (routeEntry.contentType) {
        details.push(`contentType=${routeEntry.contentType}`);
      }
      if (routeEntry.addHeaders) {
        details.push(`addHeaders=${JSON.stringify(routeEntry.addHeaders)}`);
      }
      if (routeEntry.removeHeaders) {
        details.push(`removeHeaders=${routeEntry.removeHeaders.join(",")}`);
      }

      const detailsStr = details.length ? ` (${details.join(", ")})` : "";
      lines.push(`${i + 1}. ${routeEntry.pattern}${detailsStr}`);
    }
    response.addTextResult(lines.join("\n"));
  }
});

const unroute = defineTool({
  capability: "network",
  schema: {
    name: "browser_unroute",
    title: "Remove network routes",
    description: "Remove network routes matching a pattern (or all routes if no pattern specified)",
    inputSchema: z.object({
      pattern: z.string().optional().describe("URL pattern to unroute (omit to remove all routes)")
    }),
    type: "action"
  },
  handle: async (context, params, response) => {
    const removed = await context.runtime.removeRoute(params.pattern);
    if (params.pattern) {
      response.addTextResult(`Removed ${removed} route(s) for pattern: ${params.pattern}`);
    } else {
      response.addTextResult(`Removed all ${removed} route(s)`);
    }
  }
});

function parseRouteHeaders(headers: string[]): Record<string, string> {
  return Object.fromEntries(headers.map((header) => {
    const colonIndex = header.indexOf(":");
    return [header.substring(0, colonIndex).trim(), header.substring(colonIndex + 1).trim()];
  }));
}

export default [route, routeList, unroute];
