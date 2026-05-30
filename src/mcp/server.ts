import { writeFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { isMcpToolError } from "./errors.js";
import { formatConnectResult, formatSnapshot, formatTabs, formatTabsWithOptionalSnapshot } from "./format.js";
import {
  browserRefActionSchema,
  browserSnapshotSchema,
  browserTabsSchema,
  roxyBrowserConnectSchema
} from "./schemas.js";
import { McpRuntimeManager } from "./runtime.js";
import type {
  CreateRoxyBrowserMcpServerOptions,
  RoxyBrowserConnectArgs,
  RoxyBrowserMcpServerBundle
} from "./types.js";

function textResult(text: string, isError = false): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text
      }
    ],
    ...(isError ? { isError: true } : {})
  };
}

function toolErrorResult(error: unknown): CallToolResult {
  if (isMcpToolError(error)) {
    return textResult(`[${error.code}] ${error.message}`, true);
  }

  const message = error instanceof Error ? error.message : String(error);
  return textResult(message, true);
}

function toConnectArgs(args: {
  protocol: "cdp" | "bidi";
  endpoint: string;
  browser: "chromium" | "firefox" | undefined;
}): RoxyBrowserConnectArgs {
  return {
    protocol: args.protocol,
    endpoint: args.endpoint,
    ...(args.browser ? { browser: args.browser } : {})
  };
}

export function createRoxyBrowserMcpServer(
  options: CreateRoxyBrowserMcpServerOptions = {}
): RoxyBrowserMcpServerBundle {
  const runtimeManager = new McpRuntimeManager(options.sessionFactory);
  const server = new McpServer({
    name: options.serverInfo?.name ?? "roxybrowser-mcp",
    version: options.serverInfo?.version ?? "0.1.0"
  });

  server.registerTool(
    "roxy_browser_connect",
    {
      title: "Roxy Browser Connect",
      description: "Attach to an existing browser over CDP or BiDi and seed the active tab snapshot.",
      inputSchema: roxyBrowserConnectSchema.shape
    },
    async (args, extra) => {
      try {
        const runtime = runtimeManager.getRuntime(extra.sessionId);
        const result = await runtime.connect(toConnectArgs(args));
        return textResult(formatConnectResult(result));
      } catch (error) {
        return toolErrorResult(error);
      }
    }
  );

  server.registerTool(
    "browser_tabs",
    {
      title: "Browser Tabs",
      description: "List, create, select, and close browser tabs for the current MCP browser session.",
      inputSchema: browserTabsSchema.shape
    },
    async (args, extra) => {
      try {
        const runtime = runtimeManager.getRuntime(extra.sessionId);
        if (args.action === "list") {
          const tabs = await runtime.listTabs();
          return textResult(formatTabs(tabs));
        }

        if (args.action === "new") {
          const result = await runtime.newTab(args.url);
          return textResult(formatTabsWithOptionalSnapshot(result.tabs, result.snapshot));
        }

        if (args.action === "select") {
          const result = await runtime.selectTab(args.index as number);
          return textResult(formatTabsWithOptionalSnapshot(result.tabs, result.snapshot));
        }

        const result = await runtime.closeTab(args.index as number);
        return textResult(formatTabsWithOptionalSnapshot(result.tabs, result.snapshot));
      } catch (error) {
        return toolErrorResult(error);
      }
    }
  );

  server.registerTool(
    "browser_snapshot",
    {
      title: "Browser Snapshot",
      description: "Return a Playwright-style accessibility and DOM snapshot for the active tab.",
      inputSchema: browserSnapshotSchema.shape
    },
    async (args, extra) => {
      try {
        const runtime = runtimeManager.getRuntime(extra.sessionId);
        const snapshot = await runtime.snapshot(args);
        const formatted = formatSnapshot(snapshot);
        if (args.filename) {
          await writeFile(args.filename, formatted);
          return textResult(`Saved snapshot to "${args.filename}".`);
        }
        return textResult(formatted);
      } catch (error) {
        return toolErrorResult(error);
      }
    }
  );

  server.registerTool(
    "browser_click",
    {
      title: "Browser Click",
      description: "Click a previously snapshotted element reference in the active tab.",
      inputSchema: browserRefActionSchema.shape
    },
    async (args, extra) => {
      try {
        const runtime = runtimeManager.getRuntime(extra.sessionId);
        await runtime.click(args.ref);
        return textResult(`Clicked ref "${args.ref}".`);
      } catch (error) {
        return toolErrorResult(error);
      }
    }
  );

  server.registerTool(
    "browser_hover",
    {
      title: "Browser Hover",
      description: "Hover a previously snapshotted element reference in the active tab.",
      inputSchema: browserRefActionSchema.shape
    },
    async (args, extra) => {
      try {
        const runtime = runtimeManager.getRuntime(extra.sessionId);
        await runtime.hover(args.ref);
        return textResult(`Hovered ref "${args.ref}".`);
      } catch (error) {
        return toolErrorResult(error);
      }
    }
  );

  return {
    server,
    runtimeManager,
    close: async () => {
      await runtimeManager.closeAll();
      if (server.isConnected()) {
        await server.close();
      }
    }
  };
}
