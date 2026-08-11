#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const expectedTools = [
  "browser_snapshot",
  "browser_click",
  "browser_type",
  "roxy_browser_connect"
];

const { stdout } = await execFileAsync(
  "pnpm",
  [
    "exec",
    "mcp-inspector",
    "--cli",
    "node",
    "./dist/bin/roxybrowser-mcp.js",
    "--method",
    "tools/list",
    "--format",
    "json"
  ],
  {
    cwd: new URL("..", import.meta.url),
    maxBuffer: 1024 * 1024 * 8
  }
);

const payload = JSON.parse(stdout);
const tools = payload?.result?.tools;
if (!Array.isArray(tools)) {
  throw new Error("Inspector CLI tools/list response did not include result.tools.");
}

const toolNames = new Set(
  tools
    .map((tool) => tool?.name)
    .filter((name) => typeof name === "string")
);
const missing = expectedTools.filter((name) => !toolNames.has(name));

if (missing.length > 0) {
  throw new Error(`Inspector CLI tools/list missing expected tools: ${missing.join(", ")}`);
}

console.log(`Inspector CLI listed ${toolNames.size} MCP tools.`);
