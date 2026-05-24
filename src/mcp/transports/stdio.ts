import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createRoxyBrowserMcpServer } from "../server.js";
import type { RoxyBrowserMcpStdioBundle, StartRoxyBrowserMcpStdioOptions } from "../types.js";

export async function startRoxyBrowserMcpStdio(
  options: StartRoxyBrowserMcpStdioOptions = {}
): Promise<RoxyBrowserMcpStdioBundle> {
  const bundle = createRoxyBrowserMcpServer(options);
  const transport = new StdioServerTransport(options.stdin, options.stdout);
  await bundle.server.connect(transport as Parameters<typeof bundle.server.connect>[0]);

  return {
    server: bundle.server,
    transport,
    close: async () => {
      await bundle.close();
      await transport.close();
    }
  };
}
