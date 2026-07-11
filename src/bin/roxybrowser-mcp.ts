#!/usr/bin/env node

import { parseArgs } from "node:util";
import { startRoxyBrowserMcpHttp, startRoxyBrowserMcpStdio } from "../mcp/index.js";
import type {
  CreateRoxyBrowserMcpServerOptions,
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
  artifactsDir?: string;
  downloadsDir?: string;
  screenshotsDir?: string;
  snapshotsDir?: string;
  tracesDir?: string;
  videosDir?: string;
  networkDir?: string;
  consoleDir?: string;
  scriptsDir?: string;
  tempDir?: string;
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
      "artifacts-dir": { type: "string" },
      "downloads-dir": { type: "string" },
      "screenshots-dir": { type: "string" },
      "snapshots-dir": { type: "string" },
      "traces-dir": { type: "string" },
      "videos-dir": { type: "string" },
      "network-dir": { type: "string" },
      "console-dir": { type: "string" },
      "scripts-dir": { type: "string" },
      "temp-dir": { type: "string" },
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
    ...(values["artifacts-dir"] !== undefined ? { artifactsDir: values["artifacts-dir"] } : {}),
    ...(values["downloads-dir"] !== undefined ? { downloadsDir: values["downloads-dir"] } : {}),
    ...(values["screenshots-dir"] !== undefined ? { screenshotsDir: values["screenshots-dir"] } : {}),
    ...(values["snapshots-dir"] !== undefined ? { snapshotsDir: values["snapshots-dir"] } : {}),
    ...(values["traces-dir"] !== undefined ? { tracesDir: values["traces-dir"] } : {}),
    ...(values["videos-dir"] !== undefined ? { videosDir: values["videos-dir"] } : {}),
    ...(values["network-dir"] !== undefined ? { networkDir: values["network-dir"] } : {}),
    ...(values["console-dir"] !== undefined ? { consoleDir: values["console-dir"] } : {}),
    ...(values["scripts-dir"] !== undefined ? { scriptsDir: values["scripts-dir"] } : {}),
    ...(values["temp-dir"] !== undefined ? { tempDir: values["temp-dir"] } : {}),
    ...(snapshotMode !== undefined ? { snapshotMode: snapshotMode as SnapshotMode } : {})
  };
}

function sharedOptions(options: CliOptions): Pick<
  StartRoxyBrowserMcpStdioOptions,
  | "artifactsDir"
  | "downloadsDir"
  | "screenshotsDir"
  | "snapshotsDir"
  | "tracesDir"
  | "videosDir"
  | "networkDir"
  | "consoleDir"
  | "scriptsDir"
  | "snapshotMode"
  | "tempDir"
> {
  return {
    ...(options.artifactsDir !== undefined ? { artifactsDir: options.artifactsDir } : {}),
    ...(options.downloadsDir !== undefined ? { downloadsDir: options.downloadsDir } : {}),
    ...(options.screenshotsDir !== undefined ? { screenshotsDir: options.screenshotsDir } : {}),
    ...(options.snapshotsDir !== undefined ? { snapshotsDir: options.snapshotsDir } : {}),
    ...(options.tracesDir !== undefined ? { tracesDir: options.tracesDir } : {}),
    ...(options.videosDir !== undefined ? { videosDir: options.videosDir } : {}),
    ...(options.networkDir !== undefined ? { networkDir: options.networkDir } : {}),
    ...(options.consoleDir !== undefined ? { consoleDir: options.consoleDir } : {}),
    ...(options.scriptsDir !== undefined ? { scriptsDir: options.scriptsDir } : {}),
    ...(options.tempDir !== undefined ? { tempDir: options.tempDir } : {}),
    ...(options.snapshotMode !== undefined ? { snapshotMode: options.snapshotMode } : {})
  } satisfies Partial<CreateRoxyBrowserMcpServerOptions>;
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
