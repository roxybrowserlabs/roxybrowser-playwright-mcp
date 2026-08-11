import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createRoxyBrowserMcpInMemory } from "../../dist/mcp/index.js";

const endpoint = process.env.ROXY_BIDI_ENDPOINT;
if (!endpoint) {
  throw new Error("Set ROXY_BIDI_ENDPOINT to a Firefox WebDriver BiDi endpoint.");
}

function textFromResult(result) {
  return (result.content ?? [])
    .filter((item) => item.type === "text")
    .map((item) => item.text ?? "")
    .join("\n");
}

const bundle = await createRoxyBrowserMcpInMemory({
  capabilities: ["network"]
});
const client = new Client({ name: "repro-bidi-browser-route-gap", version: "1.0.0" });

try {
  await client.connect(bundle.clientTransport);
  await client.callTool({
    name: "roxy_browser_connect",
    arguments: {
      browser: "firefox",
      endpoint
    }
  });
  const result = await client.callTool({
    name: "browser_route",
    arguments: {
      pattern: "**/api/users",
      status: 200,
      body: "[]",
      contentType: "application/json"
    }
  });
  console.log(textFromResult(result));
  if (!result.isError) {
    throw new Error("Expected browser_route to report the current BiDi MCP route gap.");
  }
} finally {
  await client.close().catch(() => undefined);
  await bundle.close();
}
