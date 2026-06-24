#!/usr/bin/env node

import { parseArgs } from "node:util";
import { startRoxyBrowserMcpHttp, startRoxyBrowserMcpStdio } from "../mcp/index.js";
import type {
  SnapshotMode,
  StartRoxyBrowserMcpHttpOptions,
  StartRoxyBrowserMcpStdioOptions
} from "../mcp/index.js";

type CliTransport = "stdio" | "http";

interface CliOptions {
  transport: CliTransport;
  host?: string;
  port?: number;
  path?: string;
  outputDir?: string;
  snapshotMode?: SnapshotMode;
}

function parseCliOptions(argv: string[]): CliOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      transport: { type: "string" },
      host: { type: "string" },
      port: { type: "string" },
      path: { type: "string" },
      "output-dir": { type: "string" },
      "snapshot-mode": { type: "string" }
    },
    allowPositionals: false
  });

  const transport = (values.transport ?? "stdio") as string;
  if (transport !== "stdio" && transport !== "http") {
    throw new Error(`Unsupported transport "${transport}". Expected "stdio" or "http".`);
  }

  const snapshotMode = values["snapshot-mode"];
  if (
    snapshotMode !== undefined
    && snapshotMode !== "full"
    && snapshotMode !== "none"
  ) {
    throw new Error(`Unsupported snapshot mode "${snapshotMode}". Expected "full" or "none".`);
  }

  const portValue = values.port;
  const port =
    portValue === undefined ? undefined : Number.parseInt(portValue, 10);
  if (portValue !== undefined && Number.isNaN(port)) {
    throw new Error(`Invalid port "${portValue}". Expected an integer.`);
  }

  return {
    transport,
    ...(values.host !== undefined ? { host: values.host } : {}),
    ...(port !== undefined ? { port } : {}),
    ...(values.path !== undefined ? { path: values.path } : {}),
    ...(values["output-dir"] !== undefined ? { outputDir: values["output-dir"] } : {}),
    ...(snapshotMode !== undefined ? { snapshotMode: snapshotMode as SnapshotMode } : {})
  };
}

function sharedOptions(options: CliOptions): Pick<
  StartRoxyBrowserMcpStdioOptions,
  "outputDir" | "snapshotMode"
> {
  return {
    ...(options.outputDir !== undefined ? { outputDir: options.outputDir } : {}),
    ...(options.snapshotMode !== undefined ? { snapshotMode: options.snapshotMode } : {})
  };
}

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));

  if (options.transport === "http") {
    const httpOptions: StartRoxyBrowserMcpHttpOptions = {
      port: options.port ?? 3333,
      ...(options.host !== undefined ? { host: options.host } : {}),
      ...(options.path !== undefined ? { path: options.path } : {}),
      ...sharedOptions(options)
    };
    const bundle = await startRoxyBrowserMcpHttp(httpOptions);
    const host = httpOptions.host ?? "127.0.0.1";
    const path = httpOptions.path ?? "/mcp";
    console.error(`RoxyBrowser MCP HTTP server listening at http://${host}:${httpOptions.port}${path}`);

    const close = async (): Promise<void> => {
      await bundle.close();
      process.exitCode = 0;
    };

    process.once("SIGINT", () => void close());
    process.once("SIGTERM", () => void close());
    return;
  }

  await startRoxyBrowserMcpStdio(sharedOptions(options));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
