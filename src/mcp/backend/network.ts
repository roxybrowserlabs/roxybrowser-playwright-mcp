import { writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { defineTool } from "./tool.js";
import type { BrowserNetworkRequest, BrowserNetworkResponseBody } from "../types.js";

const requestParts = ["request-headers", "request-body", "response-headers", "response-body"] as const;

const networkRequests = defineTool({
  capability: "core",
  schema: {
    name: "browser_network_requests",
    title: "List network requests",
    description: "Returns a numbered list of network requests since loading the page. Use browser_network_request with the number to get full details.",
    inputSchema: z.object({
      static: z.boolean().default(false).describe("Whether to include successful static resources like images, fonts, scripts, etc. Defaults to false."),
      filter: z.string().optional().refine((value) => value === undefined || isValidRegexString(value), {
        message: "Invalid regular expression"
      }).describe('Only return requests whose URL matches this regexp (e.g. "/api/.*user").'),
      filename: z.string().optional().describe("Filename to save the network requests to. If not provided, requests are returned as text.")
    }),
    type: "readOnly"
  },
  handle: async (context, args, response) => {
    const requests = await context.runtime.networkRequests();
    const filter = args.filter ? new RegExp(args.filter) : undefined;
    const lines: string[] = [];
    let hiddenStaticCount = 0;
    for (let index = 0; index < requests.length; index++) {
      const request = requests[index];
      if (!request) {
        continue;
      }
      if (!args.static && !isFetch(request) && isSuccessfulResponse(request)) {
        hiddenStaticCount++;
        continue;
      }
      if (filter && !filter.test(request.url)) {
        continue;
      }
      lines.push(`${index + 1}. ${renderRequestLine(request)}`);
    }
    if (hiddenStaticCount > 0) {
      const optionName = context.config.skillMode ? "--static" : '"static"';
      lines.push(`\nNote: ${hiddenStaticCount} static request${hiddenStaticCount === 1 ? "" : "s"} not shown, run with ${optionName} option to see ${hiddenStaticCount === 1 ? "it" : "them"}.`);
    }
    const text = lines.join("\n");
    if (args.filename) {
      const resolvedFilename = await context.resolveOutputFile(args.filename, "network");
      await context.writeTextFile(resolvedFilename, text);
      response.addTextResult(`Saved network requests to "${resolvedFilename}".`);
      return;
    }
    response.addTextResult(text);
  }
});

const networkRequest = defineTool({
  capability: "core",
  schema: {
    name: "browser_network_request",
    title: "Show network request details",
    description: "Returns full details (headers and body) of a single network request, or a single part if `part` is set. Use the number from browser_network_requests.",
    inputSchema: z.object({
      index: z.number().int().min(1).describe("1-based index of the request, as printed by browser_network_requests."),
      part: z.enum(requestParts).optional().describe("Return only this part of the request. Omit to return full details."),
      filename: z.string().optional().describe("Filename to save the result to. If not provided, output is returned as text.")
    }),
    type: "readOnly"
  },
  handle: async (context, args, response) => {
    const requests = await context.runtime.networkRequests();
    const request = requests[args.index - 1];
    if (!request) {
      response.addError(`Request #${args.index} not found. Use browser_network_requests to see available indexes.`);
      return;
    }
    if (args.part) {
      response.setRawResults();
      if (args.part === "response-body") {
        const body = request.responseBody !== undefined || request.responseBodyBase64 !== undefined
          ? {
              ...(request.responseBody !== undefined ? { text: request.responseBody } : {}),
              ...(request.responseBodyBase64 !== undefined ? { base64: request.responseBodyBase64 } : {})
            }
          : await context.runtime.fetchResponseBody(args.index);
        await addResponseBodyPart(context, response, request, body, args.filename);
        return;
      }
      const partText = renderRequestPart(request, args.part);
      if (args.filename) {
        const resolvedFilename = await context.resolveOutputFile(args.filename, "network");
        await context.writeTextFile(resolvedFilename, partText);
        response.addTextResult(`Saved network request to "${resolvedFilename}".`);
      } else {
        response.addTextResult(partText);
      }
      return;
    }
    const text = renderRequestDetails(args.index, request, !!context.config.skillMode);
    if (args.filename) {
      const resolvedFilename = await context.resolveOutputFile(args.filename, "network");
      await context.writeTextFile(resolvedFilename, text);
      response.addTextResult(`Saved network request to "${resolvedFilename}".`);
      return;
    }
    response.addTextResult(text);
  }
});

const networkClear = defineTool({
  capability: "core",
  skillOnly: true,
  schema: {
    name: "browser_network_clear",
    title: "Clear network requests",
    description: "Clear all network requests",
    inputSchema: z.object({}),
    type: "readOnly"
  },
  handle: async (context) => {
    await context.runtime.clearRequests();
  }
});

const networkStateSet = defineTool({
  capability: "network",
  schema: {
    name: "browser_network_state_set",
    title: "Set network state",
    description: "Sets the browser network state to online or offline. When offline, all network requests will fail.",
    inputSchema: z.object({
      state: z.enum(["online", "offline"]).describe('Set to "offline" to simulate offline mode, "online" to restore network connectivity')
    }),
    type: "action"
  },
  handle: async (context, params, response) => {
    const offline = params.state === "offline";
    await context.runtime.setOffline(offline);
    response.addTextResult(`Network is now ${params.state}`);
    response.addCode(`await page.context().setOffline(${offline});`);
  }
});

function isSuccessfulResponse(request: BrowserNetworkRequest): boolean {
  return !request.failureText && request.status !== undefined && request.status < 400;
}

function isFetch(request: BrowserNetworkRequest): boolean {
  return request.resourceType === "fetch" || request.resourceType === "xhr";
}

function isValidRegexString(value: string): boolean {
  try {
    new RegExp(value);
    return true;
  } catch {
    return false;
  }
}

function renderRequestLine(request: BrowserNetworkRequest): string {
  let line = `[${request.method.toUpperCase()}] ${truncateDataUrl(request.url)}`;
  if (request.status !== undefined) {
    line += ` => [${request.status}] ${request.statusText ?? ""}`.trimEnd();
  } else if (request.failureText) {
    line += ` => [FAILED] ${request.failureText}`;
  }
  return line;
}

function renderRequestDetails(index: number, request: BrowserNetworkRequest, skillMode: boolean): string {
  const lines: string[] = [];
  lines.push(`#${index} [${request.method.toUpperCase()}] ${truncateDataUrl(request.url)}`);
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
  const hints: string[] = [];
  if (request.requestBody) {
    hints.push(partHint(skillMode, "request-body", index));
  }
  if (canHaveResponseBody(request)) {
    hints.push(partHint(skillMode, "response-body", index));
  }
  if (hints.length) {
    lines.push("", ...hints);
  }
  return lines.join("\n");
}

function partHint(skillMode: boolean, part: "request-body" | "response-body", index: number): string {
  const subject = part === "request-body" ? "request body" : "response body";
  return skillMode
    ? `Run \`${part} ${index}\` to read the ${subject}.`
    : `Call browser_network_request with part="${part}" to read the ${subject}.`;
}

function renderRequestPart(request: BrowserNetworkRequest, part: typeof requestParts[number]): string {
  if (part === "request-headers") return renderHeaders(request.requestHeaders);
  if (part === "request-body") return request.requestBody ?? "";
  if (part === "response-headers") return renderHeaders(request.responseHeaders ?? {});
  return request.responseBody ?? "";
}

async function addResponseBodyPart(
  context: {
    resolveOutputFile(filename: string, kind: "network"): Promise<string>;
    writeTextFile(filename: string, text: string): Promise<void>;
    markWrittenFile(filename: string): void;
  },
  response: { addTextResult(text: string): void },
  request: BrowserNetworkRequest,
  body: BrowserNetworkResponseBody | undefined,
  suggestedFilename: string | undefined
): Promise<void> {
  if (body?.base64 !== undefined) {
    const resolvedFilename = await context.resolveOutputFile(
      suggestedFilename ?? defaultResponseBodyFilename(request),
      "network"
    );
    await writeFile(resolvedFilename, Buffer.from(body.base64, "base64"));
    context.markWrittenFile(resolvedFilename);
    response.addTextResult(
      suggestedFilename
        ? `Saved network request to "${resolvedFilename}".`
        : resolvedFilename
    );
    return;
  }
  const text = body?.text ?? "";
  if (suggestedFilename) {
    const resolvedFilename = await context.resolveOutputFile(suggestedFilename, "network");
    await context.writeTextFile(resolvedFilename, text);
    response.addTextResult(`Saved network request to "${resolvedFilename}".`);
  } else {
    response.addTextResult(text);
  }
}

function defaultResponseBodyFilename(request: BrowserNetworkRequest): string {
  return `response-body-${new Date().toISOString().replace(/[:.]/g, "-")}${responseBodyExtension(request)}`;
}

function responseBodyExtension(request: BrowserNetworkRequest): string {
  const contentType = request.mimeType ?? request.responseHeaders?.["content-type"] ?? "";
  const mimeType = contentType.split(";")[0]?.trim().toLowerCase();
  if (mimeType === "image/png") return ".png";
  if (mimeType === "image/jpeg") return ".jpg";
  if (mimeType === "image/webp") return ".webp";
  if (mimeType === "application/pdf") return ".pdf";
  const pathname = safeUrlPathname(request.url);
  const ext = pathname ? path.extname(pathname) : "";
  return ext || ".bin";
}

function safeUrlPathname(url: string): string | undefined {
  try {
    return new URL(url).pathname;
  } catch {
    return undefined;
  }
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

function canHaveResponseBody(request: BrowserNetworkRequest): boolean {
  if (request.failureText || request.status === undefined) {
    return false;
  }
  // Status codes that cannot have a response body per RFC 7230.
  return request.status !== 204 && request.status !== 304 && !(request.status >= 100 && request.status < 200);
}

function truncateDataUrl(url: string): string {
  if (!url.startsWith("data:")) {
    return url;
  }
  const comma = url.indexOf(",");
  if (comma === -1) {
    return url;
  }
  return `${url.slice(0, comma + 1)}\u2026`;
}

export default [networkRequests, networkRequest, networkClear, networkStateSet];
