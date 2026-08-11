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

async function callTool(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) {
    throw new Error(`${name} failed:\n${textFromResult(result)}`);
  }
  return result;
}

const bundle = await createRoxyBrowserMcpInMemory({
  contextOptions: {
    viewport: { width: 393, height: 659 },
    screen: { width: 393, height: 852 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5 Mobile/15E148 Safari/604.1"
  }
});
const client = new Client({ name: "verify-bidi-device-emulation-limit", version: "1.0.0" });

try {
  await client.connect(bundle.clientTransport);
  await callTool(client, "roxy_browser_connect", {
    browser: "firefox",
    endpoint
  });
  await callTool(client, "browser_navigate", {
    url: "data:text/html,<meta name=viewport content='width=device-width, initial-scale=1'><script>document.body.textContent = JSON.stringify({ width: innerWidth, ua: navigator.userAgent, dpr: devicePixelRatio, touch: navigator.maxTouchPoints })</script>"
  });
  const result = await callTool(client, "browser_evaluate", {
    function: "() => JSON.parse(document.body.textContent)"
  });
  console.log(textFromResult(result));
} finally {
  await client.close().catch(() => undefined);
  await bundle.close();
}
