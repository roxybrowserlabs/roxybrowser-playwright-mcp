import fs from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createRoxyBrowserMcpInMemory } from "../dist/mcp/index.js";

const endpoint = process.env.ROXY_CDP_ENDPOINT ?? "ws://127.0.0.1:55417/devtools/browser/42f389e8-6c5e-45c6-a2f0-a0ff2854701d";
const targetUrl = "https://www.tiktok.com/tiktokstudio/upload?from=webapp&tab=video";
const uploadXPath = '//*[@id="root"]/div/div/div[2]/div[2]/div/div[2]/div/div[1]/div/div/input';
const maxSnapshotAttempts = 8;
const snapshotRetryDelayMs = 1500;
const maxVerifyAttempts = 20;
const verifyRetryDelayMs = 2000;
const uploadPath = path.resolve("examples/006.mp4");
const uploadFileName = path.basename(uploadPath);

function textFromResult(result) {
  return (result.content ?? [])
    .filter((item) => item.type === "text")
    .map((item) => item.text ?? "")
    .join("\n");
}

function parseJsonResultBlock(text) {
  const resultIndex = text.indexOf("### Result");
  const candidate = resultIndex >= 0 ? text.slice(resultIndex + "### Result".length) : text;
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function findUploadTriggerRef(snapshotText) {
  const buttonMatch = snapshotText.match(/button "Select video" \[ref=(e\d+)\]/);
  if (buttonMatch) {
    return buttonMatch[1];
  }
  const containerMatch = snapshotText.match(/button "Select video to upload[\s\S]*?" \[ref=(e\d+)\]/);
  if (containerMatch) {
    return containerMatch[1];
  }
  return null;
}

async function main() {
  const bundle = await createRoxyBrowserMcpInMemory();
  const client = new Client({ name: "verify-roxy-mcp-tiktokstudio-file-upload", version: "1.0.0" });

  try {
    await fs.access(uploadPath);
    await client.connect(bundle.clientTransport);

    const connectResult = await callTool(client, "roxy_browser_connect", {
      browser: "chrome",
      endpoint
    });
    console.log("\n[connect]\n");
    console.log(textFromResult(connectResult));

    const navigateResult = await callTool(client, "browser_navigate", {
      url: targetUrl
    });
    console.log("\n[navigate]\n");
    console.log(textFromResult(navigateResult));

    const precheckResult = await callTool(client, "browser_evaluate", {
      function: `() => {
        const xpath = ${JSON.stringify(uploadXPath)};
        const exactInput = document.evaluate(
          xpath,
          document,
          null,
          XPathResult.FIRST_ORDERED_NODE_TYPE,
          null
        ).singleNodeValue;
        const fallbackInput = document.querySelector('input[type="file"]')
          ?? document.evaluate(
            '//input[@type="file"]',
            document,
            null,
            XPathResult.FIRST_ORDERED_NODE_TYPE,
            null
          ).singleNodeValue;
        const input = exactInput ?? fallbackInput;
        const visibleText = document.body?.innerText?.replace(/\\s+/g, " ").slice(0, 1200) ?? "";
        return {
          url: location.href,
          title: document.title,
          readyState: document.readyState,
          inputFound: Boolean(input),
          inputFoundByExactXpath: Boolean(exactInput),
          inputType: input?.tagName ?? null,
          inputDisabled: input?.disabled ?? null,
          inputAccept: input?.getAttribute?.("accept") ?? null,
          inputMultiple: input?.multiple ?? null,
          existingFiles: Array.from(input?.files ?? []).map((file) => ({
            name: file.name,
            size: file.size,
            type: file.type
          })),
          loginHint: /log in|login|sign in/i.test(visibleText),
          visibleText
        };
      }`
    });
    const precheckText = textFromResult(precheckResult);
    console.log("\n[precheck]\n");
    console.log(precheckText);
    const precheckParsed = parseJsonResultBlock(precheckText);

    let snapshotText = "";
    let uploadTriggerRef = null;
    for (let attempt = 1; attempt <= maxSnapshotAttempts; attempt += 1) {
      const snapshotResult = await callTool(client, "browser_snapshot", {});
      snapshotText = textFromResult(snapshotResult);
      console.log(`\n[snapshot attempt ${attempt}]\n`);
      console.log(snapshotText);
      uploadTriggerRef = findUploadTriggerRef(snapshotText);
      if (uploadTriggerRef) {
        break;
      }
      if (attempt < maxSnapshotAttempts) {
        await delay(snapshotRetryDelayMs);
      }
    }

    if (!uploadTriggerRef) {
      throw new Error("Could not find the TikTok upload trigger ref in browser_snapshot output.");
    }

    const clickResult = await callTool(client, "browser_click", {
      target: uploadTriggerRef
    });
    console.log(`\n[click ref=${uploadTriggerRef}]\n`);
    console.log(textFromResult(clickResult));

    const uploadResult = await callTool(client, "browser_file_upload", {
      paths: [uploadPath]
    });
    console.log("\n[file_upload]\n");
    console.log(textFromResult(uploadResult));

    let parsed = null;
    for (let attempt = 1; attempt <= maxVerifyAttempts; attempt += 1) {
      const verifyResult = await callTool(client, "browser_evaluate", {
        function: `() => {
          const xpath = ${JSON.stringify(uploadXPath)};
          const exactInput = document.evaluate(
            xpath,
            document,
            null,
            XPathResult.FIRST_ORDERED_NODE_TYPE,
            null
          ).singleNodeValue;
          const fallbackInput = document.querySelector('input[type="file"]')
            ?? document.evaluate(
              '//input[@type="file"]',
              document,
              null,
              XPathResult.FIRST_ORDERED_NODE_TYPE,
              null
            ).singleNodeValue;
          const input = exactInput ?? fallbackInput;
          const files = Array.from(input?.files ?? []).map((file) => ({
            name: file.name,
            size: file.size,
            type: file.type
          }));
          const visibleText = document.body?.innerText?.replace(/\\s+/g, " ").trim().slice(0, 3000) ?? "";
          const hasFilename = visibleText.includes(${JSON.stringify(uploadFileName)});
          const hasEditorUi = /Details|Description|Cover|Who can see this post|Upload another video|Post|Save draft|Discard/i.test(visibleText);
          const hasProgressUi = /Uploading|Processing|Checking|Uploaded|Complete|Progress|%/i.test(visibleText);
          return {
            url: location.href,
            title: document.title,
            inputFound: Boolean(input),
            inputFoundByExactXpath: Boolean(exactInput),
            files,
            fileCount: files.length,
            uploadLooksAccepted: files.some((file) => file.name === ${JSON.stringify(uploadFileName)}) || hasFilename || hasEditorUi || hasProgressUi,
            inputOuterHtml: input?.outerHTML?.slice(0, 500) ?? null,
            loginHint: /log in|login|sign in/i.test(visibleText),
            hasFilename,
            hasEditorUi,
            hasProgressUi,
            visibleText
          };
        }`
      });
      const verifyText = textFromResult(verifyResult);
      console.log(`\n[verify attempt ${attempt}]\n`);
      console.log(verifyText);
      parsed = parseJsonResultBlock(verifyText);
      if (parsed.uploadLooksAccepted) {
        break;
      }
      if (attempt < maxVerifyAttempts) {
        await delay(verifyRetryDelayMs);
      }
    }

    if (!parsed) {
      throw new Error("Did not receive verification result.");
    }
    if (!precheckParsed.inputFound) {
      throw new Error("Target upload input was not found before upload started on the TikTok Studio upload page.");
    }
    if (!parsed.uploadLooksAccepted) {
      throw new Error(
        `Upload UI did not transition to an accepted state. fileCount=${parsed.fileCount}, title="${parsed.title}", loginHint=${parsed.loginHint}, hasEditorUi=${parsed.hasEditorUi}, hasProgressUi=${parsed.hasProgressUi}, hasFilename=${parsed.hasFilename}`
      );
    }

    console.log("\nVerification passed.");
    console.log(`- uploaded file name: ${parsed.files[0]?.name ?? "(not retained on input)"}`);
    console.log(`- uploaded file type: ${parsed.files[0]?.type ?? "(not retained on input)"}`);
    console.log(`- page title: ${parsed.title}`);
    console.log(`- editor UI visible: ${parsed.hasEditorUi}`);
    console.log(`- progress UI visible: ${parsed.hasProgressUi}`);
  } finally {
    await client.close().catch(() => {});
    await bundle.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
