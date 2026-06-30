import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createRoxyBrowserMcpInMemory } from "../dist/mcp/index.js";

const endpoint = "ws://127.0.0.1:63543/devtools/browser/cbf04210-8d26-4594-97f3-fea1fe268233"

if (!endpoint) {
  throw new Error(
    "Set ROXY_CDP_ENDPOINT or ROXY_CDP_WS_ENDPOINT to a ws://.../devtools/browser/<id> endpoint before running this example."
  );
}

const searchText = "指纹浏览器";
const baiduUrl = "https://www.baidu.com";

function textFromResult(result) {
  return (result.content ?? [])
    .filter((item) => item.type === "text")
    .map((item) => item.text ?? "")
    .join("\n");
}

function parseEvaluateResult(result) {
  const rawText = textFromResult(result).replace(/^### Result\s*/, "");
  return JSON.parse(rawText);
}

async function callTool(client, name, args) {
  const result = await client.callTool({
    name,
    arguments: args
  });
  if (result.isError) {
    throw new Error(`${name} failed:\n${textFromResult(result)}`);
  }
  return result;
}

async function main() {
  const bundle = await createRoxyBrowserMcpInMemory();
  const client = new Client({
    name: "verify-mcp-baidu-search",
    version: "1.0.0"
  });

  try {
    await client.connect(bundle.clientTransport);

    const connectResult = await callTool(client, "roxy_browser_connect", {
      browser: "chrome",
      endpoint
    });
    console.log("\n[connect]\n");
    console.log(textFromResult(connectResult));

    const navigateResult = await callTool(client, "browser_navigate", {
      url: baiduUrl
    });
    console.log("\n[navigate]\n");
    console.log(textFromResult(navigateResult));

    await callTool(client, "browser_wait_for", { time: 2 });

    const beforeResult = await callTool(client, "browser_evaluate", {
      function: `() => {
        const input = document.querySelector("#chat-textarea");
        return {
          exists: Boolean(input),
          value: input?.value ?? null,
          placeholder: input?.getAttribute("placeholder") ?? null,
          title: document.title,
          url: location.href
        };
      }`
    });
    const before = parseEvaluateResult(beforeResult);
    console.log("\n[before]\n");
    console.log(JSON.stringify(before, null, 2));

    if (!before.exists) {
      throw new Error("Could not find the Baidu search input (#chat-textarea) after navigation.");
    }

    const typeResult = await callTool(client, "browser_type", {
      target: "#chat-textarea",
      text: searchText,
      submit: true
    });
    console.log("\n[type]\n");
    console.log(textFromResult(typeResult));

    await callTool(client, "browser_wait_for", { time: 2 });

    const afterResult = await callTool(client, "browser_evaluate", {
      function: `() => {
        const input = document.querySelector("#chat-textarea");
        return {
          exists: Boolean(input),
          value: input?.value ?? null,
          placeholder: input?.getAttribute("placeholder") ?? null,
          activeId: document.activeElement?.id ?? null,
          title: document.title,
          url: location.href,
          hasSearchQueryInUrl: location.href.includes("wd=")
        };
      }`
    });
    const after = parseEvaluateResult(afterResult);
    console.log("\n[after]\n");
    console.log(JSON.stringify(after, null, 2));

    if (after.value !== searchText) {
      throw new Error(
        `Expected #chat-textarea.value to be "${searchText}", but received "${after.value}".`
      );
    }

    if (after.placeholder !== before.placeholder) {
      throw new Error(
        `Expected #chat-textarea.placeholder to stay "${before.placeholder}", but received "${after.placeholder}".`
      );
    }

    if (!after.hasSearchQueryInUrl) {
      throw new Error(`Expected Baidu search results URL to include "wd=", got "${after.url}".`);
    }

    console.log("\nVerification passed.");
    console.log(`- input value: ${after.value}`);
    console.log(`- placeholder unchanged: ${after.placeholder}`);
    console.log(`- search url: ${after.url}`);
  } finally {
    await client.close().catch(() => {});
    await bundle.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
