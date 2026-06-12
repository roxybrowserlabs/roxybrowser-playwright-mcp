import { writeFile } from "node:fs/promises";
import { z } from "zod";
import { defineTool, textResult } from "../tool.js";
import type { BrowserNetworkRequest } from "../types.js";

const requestParts = ["request-headers", "request-body", "response-headers", "response-body"] as const;

const networkRequests = defineTool({
  schema: {
    name: "browser_network_requests",
    title: "List network requests",
    description: "Returns a numbered list of network requests since loading the page. Use browser_network_request with the number to get full details.",
    inputSchema: z.object({
      static: z.boolean().default(false).describe("Whether to include successful static resources like images, fonts, scripts, etc. Defaults to false."),
      filter: z.string().optional().describe('Only return requests whose URL matches this regexp (e.g. "/api/.*user").'),
      filename: z.string().optional().describe("Filename to save the network requests to. If not provided, requests are returned as text.")
    })
  },
  handle: async (args, runtime) => {
    const requests = await runtime.networkRequests();
    const filter = args.filter ? new RegExp(args.filter) : undefined;
    const lines: string[] = [];
    let hiddenStaticCount = 0;
    for (const request of requests) {
      if (!args.static && !isFetch(request) && isSuccessfulResponse(request)) {
        hiddenStaticCount++;
        continue;
      }
      if (filter && !filter.test(request.url)) {
        continue;
      }
      lines.push(`${request.index}. ${renderRequestLine(request)}`);
    }
    if (hiddenStaticCount > 0) {
      lines.push(`\nNote: ${hiddenStaticCount} static request${hiddenStaticCount === 1 ? "" : "s"} not shown, run with "static" option to see ${hiddenStaticCount === 1 ? "it" : "them"}.`);
    }
    const text = lines.join("\n");
    if (args.filename) {
      await writeFile(args.filename, text);
      return textResult(`Saved network requests to "${args.filename}".`);
    }
    return textResult(text);
  }
});

const networkRequest = defineTool({
  schema: {
    name: "browser_network_request",
    title: "Show network request details",
    description: "Returns full details (headers and body) of a single network request, or a single part if part is set. Use the number from browser_network_requests.",
    inputSchema: z.object({
      index: z.number().int().min(1).describe("1-based index of the request, as printed by browser_network_requests."),
      part: z.enum(requestParts).optional().describe("Return only this part of the request. Omit to return full details."),
      filename: z.string().optional().describe("Filename to save the result to. If not provided, output is returned as text.")
    })
  },
  handle: async (args, runtime) => {
    const request = await runtime.networkRequest(args.index);
    if (!request) {
      return textResult(`Request #${args.index} not found. Use browser_network_requests to see available indexes.`, true);
    }
    const text = args.part ? renderRequestPart(request, args.part) : renderRequestDetails(request);
    if (args.filename) {
      await writeFile(args.filename, text);
      return textResult(`Saved network request to "${args.filename}".`);
    }
    return textResult(text);
  }
});

function isSuccessfulResponse(request: BrowserNetworkRequest): boolean {
  return !request.failureText && request.status !== undefined && request.status < 400;
}

function isFetch(request: BrowserNetworkRequest): boolean {
  return request.resourceType === "fetch" || request.resourceType === "xhr";
}

function renderRequestLine(request: BrowserNetworkRequest): string {
  let line = `[${request.method.toUpperCase()}] ${request.url}`;
  if (request.status !== undefined) {
    line += ` => [${request.status}] ${request.statusText ?? ""}`.trimEnd();
  } else if (request.failureText) {
    line += ` => [FAILED] ${request.failureText}`;
  }
  return line;
}

function renderRequestDetails(request: BrowserNetworkRequest): string {
  const lines: string[] = [];
  lines.push(`#${request.index} [${request.method.toUpperCase()}] ${request.url}`);
  lines.push("");
  lines.push("  General");
  if (request.status !== undefined) {
    lines.push(`    status:    [${request.status}] ${request.statusText ?? ""}`.trimEnd());
  } else if (request.failureText) {
    lines.push(`    status:    [FAILED] ${request.failureText}`);
  }
  if (request.durationMs !== undefined) {
    lines.push(`    duration:  ${request.durationMs}ms`);
  }
  lines.push(`    type:      ${request.resourceType}`);
  if (request.mimeType) {
    lines.push(`    mimeType:  ${request.mimeType}`);
  }
  appendHeaders(lines, "Request headers", request.requestHeaders);
  if (request.responseHeaders) {
    appendHeaders(lines, "Response headers", request.responseHeaders);
  }
  if (request.requestBody) {
    lines.push("", `Call browser_network_request with part="request-body" to read the request body.`);
  }
  if (request.responseBody) {
    lines.push("", `Call browser_network_request with part="response-body" to read the response body.`);
  }
  return lines.join("\n");
}

function renderRequestPart(request: BrowserNetworkRequest, part: typeof requestParts[number]): string {
  if (part === "request-headers") return renderHeaders(request.requestHeaders);
  if (part === "request-body") return request.requestBody ?? "";
  if (part === "response-headers") return renderHeaders(request.responseHeaders ?? {});
  return request.responseBody ?? "";
}

function appendHeaders(lines: string[], title: string, headers: Record<string, string>): void {
  const entries = Object.entries(headers);
  if (!entries.length) return;
  lines.push("");
  lines.push(`  ${title}`);
  for (const [key, value] of entries) {
    lines.push(`    ${key}: ${value}`);
  }
}

function renderHeaders(headers: Record<string, string>): string {
  return Object.entries(headers).map(([key, value]) => `${key}: ${value}`).join("\n");
}

export default [networkRequests, networkRequest];
