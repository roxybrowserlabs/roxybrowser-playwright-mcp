import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createRoxyBrowserLaunchTool } from "../backend/connect.js";
import { createRoxyBrowserMcpServer } from "../server.js";
import type {
  CreateRoxyBrowserMcpInMemoryOptions,
  RoxyBrowserMcpInMemoryBundle
} from "../types.js";

export async function createRoxyBrowserMcpInMemory(
  options: CreateRoxyBrowserMcpInMemoryOptions = {}
): Promise<RoxyBrowserMcpInMemoryBundle> {
  const { roxyBrowserLaunch, ...serverOptions } = options;
  const bundle = createRoxyBrowserMcpServer(
    serverOptions,
    {
      extraBackendTools: roxyBrowserLaunch
        ? [createRoxyBrowserLaunchTool(roxyBrowserLaunch)]
        : []
    }
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await bundle.server.connect(serverTransport as Parameters<typeof bundle.server.connect>[0]);

  return {
    server: bundle.server,
    runtimeManager: bundle.runtimeManager,
    ...(bundle.getLastSessionId ? { getLastSessionId: bundle.getLastSessionId } : {}),
    serverTransport,
    clientTransport,
    close: async () => {
      await bundle.close();
      await serverTransport.close();
      await clientTransport.close();
    }
  };
}
