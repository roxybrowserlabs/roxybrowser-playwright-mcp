#!/usr/bin/env node

import { startRoxyBrowserMcpStdio } from "../mcp/index.js";

void startRoxyBrowserMcpStdio().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
