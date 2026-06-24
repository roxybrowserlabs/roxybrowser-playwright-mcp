import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createRoxyBrowserMcpServer } from "../server.js";
import type {
  CreateRoxyBrowserMcpServerOptions,
  RoxyBrowserMcpInMemoryBundle
} from "../types.js";

export async function createRoxyBrowserMcpInMemory(
  options: CreateRoxyBrowserMcpServerOptions = {}
): Promise<RoxyBrowserMcpInMemoryBundle> {
  const bundle = createRoxyBrowserMcpServer(options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await bundle.server.connect(serverTransport as Parameters<typeof bundle.server.connect>[0]);

  return {
    server: bundle.server,
    runtimeManager: bundle.runtimeManager,
    serverTransport,
    clientTransport,
    close: async () => {
      await bundle.close();
      await serverTransport.close();
      await clientTransport.close();
    }
  };
}
