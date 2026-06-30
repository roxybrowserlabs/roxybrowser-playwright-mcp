import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

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

function parseJsonResultBlock(text) {
  const resultIndex = text.indexOf("### Result");
  const candidate =
    resultIndex >= 0 ? text.slice(resultIndex + "### Result".length) : text;
  const start = candidate.indexOf("{");
  if (start < 0) {
    throw new Error(`Could not find JSON object in tool result:\n${text}`);
  }

  let depth = 0;
  let inString = false;
  let escapeNext = false;
  for (let index = start; index < candidate.length; index += 1) {
    const char = candidate[index];
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (char === "\\") {
      escapeNext = true;
      continue;
    }
    if (char === "\"") {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return JSON.parse(candidate.slice(start, index + 1));
      }
    }
  }

  throw new Error(`Could not parse complete JSON object from tool result:\n${text}`);
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

function playwrightMcpCliPath() {
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve("@playwright/mcp/package.json")), "cli.js");
}

async function createPlaywrightMcpClient() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      playwrightMcpCliPath(),
      "--cdp-endpoint",
      endpoint,
      "--browser",
      "chrome",
      "--snapshot-mode",
      "full"
    ],
    cwd: process.cwd(),
    stderr: "pipe"
  });
  const stderrChunks = [];
  transport.stderr?.on("data", (chunk) => stderrChunks.push(String(chunk)));

  const client = new Client({
    name: "verify-playwright-mcp-baidu-search",
    version: "1.0.0"
  });

  try {
    await client.connect(transport);
  } catch (error) {
    const stderr = stderrChunks.join("").trim();
    throw new Error(
      `Unable to start Playwright MCP.${stderr ? `\n\nstderr:\n${stderr}` : ""}\n\n${String(error)}`
    );
  }

  return {
    client,
    close: async () => {
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
    }
  };
}

async function main() {
  const { client, close } = await createPlaywrightMcpClient();

  try {
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
          aiPlaceholder: input?.getAttribute("data-ai-placeholder") ?? null,
          normalPlaceholder: input?.getAttribute("data-normal-placeholder") ?? null,
          title: document.title,
          url: location.href
        };
      }`
    });
    const beforeText = textFromResult(beforeResult);
    const before = parseJsonResultBlock(beforeText);
    console.log("\n[before]\n");
    console.log(JSON.stringify(before, null, 2));

    if (!before.exists) {
      throw new Error("Could not find the Baidu chat input (#chat-textarea) after navigation.");
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
          aiPlaceholder: input?.getAttribute("data-ai-placeholder") ?? null,
          normalPlaceholder: input?.getAttribute("data-normal-placeholder") ?? null,
          activeId: document.activeElement?.id ?? null,
          title: document.title,
          url: location.href
        };
      }`
    });
    const afterText = textFromResult(afterResult);
    const after = parseJsonResultBlock(afterText);
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

    console.log("\nVerification passed.");
    console.log(`- input value: ${after.value}`);
    console.log(`- placeholder unchanged: ${after.placeholder}`);
    console.log(`- title: ${after.title}`);
    console.log(`- url: ${after.url}`);
  } finally {
    await close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
