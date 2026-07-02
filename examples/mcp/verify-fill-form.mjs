import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createRoxyBrowserMcpInMemory } from "../../dist/mcp/index.js";
import { requiredCdpEndpoint } from "./helpers/env.mjs";

const endpoint = requiredCdpEndpoint();
const TOOL_TIMEOUT_MS = 5 * 60 * 1000;
const uploadFileName = "verify-fill-form-upload.txt";
const uploadFileText = "uploaded through verify-fill-form";

const fieldsToFill = [
  { name: "Text", type: "textbox", target: "#textInput", value: "plain text value" },
  { name: "Search", type: "textbox", target: "#searchInput", value: "search keywords" },
  { name: "Telephone", type: "textbox", target: "#telInput", value: "+1-555-0100" },
  { name: "URL", type: "textbox", target: "#urlInput", value: "https://example.com/form" },
  { name: "Email", type: "textbox", target: "#emailInput", value: "form@example.com" },
  { name: "Password", type: "textbox", target: "#passwordInput", value: "secret-123" },
  { name: "Number", type: "textbox", target: "#numberInput", value: "42" },
  { name: "Date", type: "textbox", target: "#dateInput", value: "2026-07-01" },
  { name: "Month", type: "textbox", target: "#monthInput", value: "2026-07" },
  { name: "Week", type: "textbox", target: "#weekInput", value: "2026-W27" },
  { name: "Time", type: "textbox", target: "#timeInput", value: "14:30" },
  { name: "Datetime local", type: "textbox", target: "#datetimeInput", value: "2026-07-01T14:30" },
  { name: "Color", type: "textbox", target: "#colorInput", value: "#3366cc" },
  { name: "Range", type: "slider", target: "#rangeInput", value: "73" },
  { name: "Datalist text input", type: "textbox", target: "#datalistInput", value: "Beta choice" },
  { name: "Textarea", type: "textbox", target: "#textareaInput", value: "First line\nSecond line" },
  { name: "Contenteditable", type: "textbox", target: "#editableInput", value: "Editable text value" },
  { name: "Checkbox opt in", type: "checkbox", target: "#checkboxOptIn", value: "true" },
  { name: "Checkbox opt out", type: "checkbox", target: "#checkboxOptOut", value: "false" },
  { name: "Radio blue", type: "radio", target: "#radioBlue", value: "true" },
  { name: "Single select", type: "combobox", target: "#singleSelect", value: "beta" },
  { name: "Grouped select", type: "combobox", target: "#groupedSelect", value: "group-b" },
  { name: "Multiple select", type: "combobox", target: "#multipleSelect", value: "multi-b" }
];

function sleep(min, max) {
  return new Promise((r) => setTimeout(r, Math.floor(Math.random() * (max - min + 1)) + min));
}

const expectedValues = Object.fromEntries(fieldsToFill.map((field) => [field.target.slice(1), field.value]));

const fixtureUrl = `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>MCP Fill Form Verify</title>
    <style>
      body {
        color: #172033;
        font-family: system-ui, sans-serif;
        margin: 0;
        padding: 24px;
        background: #f6f8fb;
      }
      form {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
        gap: 14px;
        max-width: 980px;
      }
      fieldset {
        border: 1px solid #c8d1df;
        padding: 14px;
      }
      label {
        display: grid;
        gap: 6px;
      }
      input,
      select,
      textarea,
      button,
      [contenteditable="true"] {
        box-sizing: border-box;
        min-height: 34px;
        width: 100%;
        border: 1px solid #9aa8ba;
        padding: 6px 8px;
        font: inherit;
        background: white;
      }
      input[type="checkbox"],
      input[type="radio"],
      input[type="color"],
      input[type="range"],
      input[type="image"] {
        width: auto;
      }
      .inline {
        align-items: center;
        display: flex;
        gap: 8px;
      }
      .readonly-controls {
        grid-column: 1 / -1;
      }
    </style>
  </head>
  <body>
    <h1>MCP Fill Form Verify</h1>
    <form id="fixtureForm" aria-label="All form controls">
      <input id="hiddenToken" name="hiddenToken" type="hidden" value="hidden-initial" />

      <label>Text <input id="textInput" name="textInput" type="text" value="old text" /></label>
      <label>Search <input id="searchInput" name="searchInput" type="search" value="old search" /></label>
      <label>Telephone <input id="telInput" name="telInput" type="tel" value="000" /></label>
      <label>URL <input id="urlInput" name="urlInput" type="url" value="https://old.example" /></label>
      <label>Email <input id="emailInput" name="emailInput" type="email" value="old@example.com" /></label>
      <label>Password <input id="passwordInput" name="passwordInput" type="password" value="old-secret" /></label>
      <label>Number <input id="numberInput" name="numberInput" type="number" value="7" /></label>
      <label>Date <input id="dateInput" name="dateInput" type="date" value="2025-01-01" /></label>
      <label>Month <input id="monthInput" name="monthInput" type="month" value="2025-01" /></label>
      <label>Week <input id="weekInput" name="weekInput" type="week" value="2025-W01" /></label>
      <label>Time <input id="timeInput" name="timeInput" type="time" value="09:15" /></label>
      <label>Datetime local <input id="datetimeInput" name="datetimeInput" type="datetime-local" value="2025-01-01T09:15" /></label>
      <label>Color <input id="colorInput" name="colorInput" type="color" value="#ff0000" /></label>
      <label>Range <input id="rangeInput" name="rangeInput" type="range" min="0" max="100" value="10" /></label>

      <label>Datalist
        <input id="datalistInput" name="datalistInput" type="text" list="choices" value="Alpha choice" />
        <datalist id="choices">
          <option value="Alpha choice"></option>
          <option value="Beta choice"></option>
          <option value="Gamma choice"></option>
        </datalist>
      </label>

      <label>Textarea <textarea id="textareaInput" name="textareaInput">old text area</textarea></label>
      <label>Contenteditable <span id="editableInput" role="textbox" contenteditable="true">old editable</span></label>

      <fieldset>
        <legend>Checkboxes</legend>
        <label class="inline"><input id="checkboxOptIn" name="checkboxOptIn" type="checkbox" /> Opt in</label>
        <label class="inline"><input id="checkboxOptOut" name="checkboxOptOut" type="checkbox" checked /> Opt out</label>
      </fieldset>

      <fieldset>
        <legend>Radios</legend>
        <label class="inline"><input id="radioRed" name="radioColor" type="radio" value="red" checked /> Red</label>
        <label class="inline"><input id="radioBlue" name="radioColor" type="radio" value="blue" /> Blue</label>
      </fieldset>

      <label>Single select
        <select id="singleSelect" name="singleSelect">
          <option value="alpha">Alpha</option>
          <option value="beta">Beta</option>
          <option value="gamma">Gamma</option>
        </select>
      </label>

      <label>Grouped select
        <select id="groupedSelect" name="groupedSelect">
          <optgroup label="Group A">
            <option value="group-a">Group A</option>
          </optgroup>
          <optgroup label="Group B">
            <option value="group-b">Group B</option>
          </optgroup>
        </select>
      </label>

      <label>Multiple select
        <select id="multipleSelect" name="multipleSelect" multiple>
          <option value="multi-a" selected>Multi A</option>
          <option value="multi-b">Multi B</option>
          <option value="multi-c">Multi C</option>
        </select>
      </label>

      <section class="readonly-controls" aria-label="Controls present but not filled by browser_fill_form">
        <label>File <input id="fileInput" name="fileInput" type="file" /></label>
        <input id="submitInput" name="submitInput" type="submit" value="Submit input" />
        <input id="resetInput" name="resetInput" type="reset" value="Reset input" />
        <input id="buttonInput" name="buttonInput" type="button" value="Button input" />
        <input id="imageInput" name="imageInput" type="image" alt="Image submit" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" />
        <button id="buttonElement" name="buttonElement" type="button">Button element</button>
        <output id="outputElement" name="outputElement">output-initial</output>
        <progress id="progressElement" max="100" value="20"></progress>
        <meter id="meterElement" min="0" max="100" value="20"></meter>
        <object id="objectElement" name="objectElement" type="text/html" data="about:blank"></object>
      </section>
    </form>

    <script>
      globalThis.__roxyFormEvents = [];
      const record = (event) => {
        const target = event.target;
        if (target?.id) {
          globalThis.__roxyFormEvents.push(event.type + ":" + target.id);
        }
      };
      for (const element of document.querySelectorAll("input, textarea, select, [contenteditable='true']")) {
        element.addEventListener("input", record);
        element.addEventListener("change", record);
        element.addEventListener("click", record);
        element.addEventListener("focus", record);
      }
    </script>
  </body>
</html>`)}`;

function textFromResult(result) {
  return (result.content ?? [])
    .filter((item) => item.type === "text")
    .map((item) => item.text ?? "")
    .join("\n");
}

function parseEvaluateResult(result) {
  return JSON.parse(textFromResult(result).replace(/^### Result\s*/, ""));
}

async function callTool(client, name, args, options = {}) {
  const result = await client.callTool({
    name,
    arguments: args
  }, undefined, {
    timeout: TOOL_TIMEOUT_MS,
    ...options
  });
  if (result.isError) {
    throw new Error(`${name} failed:\n${textFromResult(result)}`);
  }
  return result;
}

async function main() {
  const bundle = await createRoxyBrowserMcpInMemory();
  const client = new Client({ name: "verify-mcp-fill-form", version: "1.0.0" });
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "roxy-fill-form-"));
  const uploadPath = path.join(tempDir, uploadFileName);

  try {
    await fs.writeFile(uploadPath, uploadFileText);
    await client.connect(bundle.clientTransport);

    const connectResult = await callTool(client, "roxy_browser_connect", {
      browser: "chrome",
      endpoint
    });
    console.log("\n[connect]\n");
    console.log(textFromResult(connectResult));

    const navigateResult = await callTool(client, "browser_navigate", {
      url: fixtureUrl
    });
    console.log("\n[navigate]\n");
    console.log(textFromResult(navigateResult));

    const fillResult = await callTool(client, "browser_fill_form", {
      human: { profile: "fast" },
      fields: fieldsToFill
    });
    console.log("\n[fill_form]\n");
    console.log(textFromResult(fillResult));

    const fileClickResult = await callTool(client, "browser_click", {
      target: "#fileInput",
      human: { profile: "fast" }
    });
    console.log("\n[file_click]\n");
    console.log(textFromResult(fileClickResult));

    const fileUploadResult = await callTool(client, "browser_file_upload", {
      paths: [uploadPath]
    });
    console.log("\n[file_upload]\n");
    console.log(textFromResult(fileUploadResult));

    const evaluateResult = await callTool(client, "browser_evaluate", {
      function: `async () => {
        const valueOf = (id) => {
          const element = document.getElementById(id);
          if (!element) return null;
          if (element.isContentEditable) return element.textContent;
          if (element instanceof HTMLSelectElement && element.multiple) {
            return Array.from(element.selectedOptions).map((option) => option.value);
          }
          if (element instanceof HTMLInputElement && (element.type === "checkbox" || element.type === "radio")) {
            return element.checked;
          }
          if ("value" in element) return element.value;
          return element.textContent;
        };
        const fileInput = document.getElementById("fileInput");
        const uploadedFiles = Array.from(fileInput?.files ?? []);
        return {
          values: {
            hiddenToken: valueOf("hiddenToken"),
            textInput: valueOf("textInput"),
            searchInput: valueOf("searchInput"),
            telInput: valueOf("telInput"),
            urlInput: valueOf("urlInput"),
            emailInput: valueOf("emailInput"),
            passwordInput: valueOf("passwordInput"),
            numberInput: valueOf("numberInput"),
            dateInput: valueOf("dateInput"),
            monthInput: valueOf("monthInput"),
            weekInput: valueOf("weekInput"),
            timeInput: valueOf("timeInput"),
            datetimeInput: valueOf("datetimeInput"),
            colorInput: valueOf("colorInput"),
            rangeInput: valueOf("rangeInput"),
            datalistInput: valueOf("datalistInput"),
            textareaInput: valueOf("textareaInput"),
            editableInput: valueOf("editableInput"),
            checkboxOptIn: valueOf("checkboxOptIn"),
            checkboxOptOut: valueOf("checkboxOptOut"),
            radioRed: valueOf("radioRed"),
            radioBlue: valueOf("radioBlue"),
            singleSelect: valueOf("singleSelect"),
            groupedSelect: valueOf("groupedSelect"),
            multipleSelect: valueOf("multipleSelect"),
            fileInput: await Promise.all(uploadedFiles.map(async (file) => ({
              name: file.name,
              size: file.size,
              type: file.type,
              text: await file.text()
            })))
          },
          presentOnly: {
            hiddenTokenValue: document.getElementById("hiddenToken")?.value ?? null,
            submitInputType: document.getElementById("submitInput")?.type ?? null,
            resetInputType: document.getElementById("resetInput")?.type ?? null,
            buttonInputType: document.getElementById("buttonInput")?.type ?? null,
            imageInputType: document.getElementById("imageInput")?.type ?? null,
            buttonElementTag: document.getElementById("buttonElement")?.tagName.toLowerCase() ?? null,
            outputText: document.getElementById("outputElement")?.textContent ?? null,
            progressValue: document.getElementById("progressElement")?.value ?? null,
            meterValue: document.getElementById("meterElement")?.value ?? null,
            fieldsetCount: document.querySelectorAll("fieldset").length,
            labelCount: document.querySelectorAll("label").length,
            datalistOptions: Array.from(document.querySelectorAll("#choices option")).map((option) => option.value),
            objectTag: document.getElementById("objectElement")?.tagName.toLowerCase() ?? null
          },
          events: globalThis.__roxyFormEvents ?? []
        };
      }`
    });

    const parsed = parseEvaluateResult(evaluateResult);
    console.log("\n[evaluate]\n");
    console.log(JSON.stringify(parsed, null, 2));

    assertEqual(parsed.values.textInput, expectedValues.textInput, "text input");
    assertEqual(parsed.values.searchInput, expectedValues.searchInput, "search input");
    assertEqual(parsed.values.telInput, expectedValues.telInput, "tel input");
    assertEqual(parsed.values.urlInput, expectedValues.urlInput, "url input");
    assertEqual(parsed.values.emailInput, expectedValues.emailInput, "email input");
    assertEqual(parsed.values.passwordInput, expectedValues.passwordInput, "password input");
    assertEqual(parsed.values.numberInput, expectedValues.numberInput, "number input");
    assertEqual(parsed.values.dateInput, expectedValues.dateInput, "date input");
    assertEqual(parsed.values.monthInput, expectedValues.monthInput, "month input");
    assertEqual(parsed.values.weekInput, expectedValues.weekInput, "week input");
    assertEqual(parsed.values.timeInput, expectedValues.timeInput, "time input");
    assertEqual(parsed.values.datetimeInput, expectedValues.datetimeInput, "datetime-local input");
    assertEqual(parsed.values.colorInput, expectedValues.colorInput, "color input");
    assertEqual(parsed.values.rangeInput, expectedValues.rangeInput, "range input");
    assertEqual(parsed.values.datalistInput, expectedValues.datalistInput, "datalist-backed input");
    assertEqual(parsed.values.textareaInput, expectedValues.textareaInput, "textarea");
    assertEqual(parsed.values.editableInput, expectedValues.editableInput, "contenteditable textbox");
    assertEqual(parsed.values.checkboxOptIn, true, "checked checkbox");
    assertEqual(parsed.values.checkboxOptOut, false, "unchecked checkbox");
    assertEqual(parsed.values.radioRed, false, "unselected radio");
    assertEqual(parsed.values.radioBlue, true, "selected radio");
    assertEqual(parsed.values.singleSelect, expectedValues.singleSelect, "single select");
    assertEqual(parsed.values.groupedSelect, expectedValues.groupedSelect, "optgroup select");
    assertEqual(parsed.values.multipleSelect, ["multi-b"], "multiple select");
    assertEqual(parsed.values.fileInput, [{
      name: uploadFileName,
      size: uploadFileText.length,
      type: "text/plain",
      text: uploadFileText
    }], "file input upload");

    assertEqual(parsed.presentOnly.hiddenTokenValue, "hidden-initial", "hidden input presence");
    assertEqual(parsed.presentOnly.submitInputType, "submit", "submit input presence");
    assertEqual(parsed.presentOnly.resetInputType, "reset", "reset input presence");
    assertEqual(parsed.presentOnly.buttonInputType, "button", "button input presence");
    assertEqual(parsed.presentOnly.imageInputType, "image", "image input presence");
    assertEqual(parsed.presentOnly.buttonElementTag, "button", "button element presence");
    assertEqual(parsed.presentOnly.outputText, "output-initial", "output element presence");
    assertEqual(parsed.presentOnly.progressValue, 20, "progress element presence");
    assertEqual(parsed.presentOnly.meterValue, 20, "meter element presence");
    assertEqual(parsed.presentOnly.fieldsetCount, 2, "fieldset presence");
    assertEqual(parsed.presentOnly.objectTag, "object", "object form-associated element presence");
    if (!parsed.presentOnly.datalistOptions.includes("Beta choice")) {
      throw new Error("Expected datalist option 'Beta choice' to be present.");
    }

    await sleep(10000, 15000); // wait for any delayed events to fire

    console.log("\nVerification passed.");
    console.log(`- browser_fill_form fields filled: ${fieldsToFill.length}`);
    console.log(`- browser_file_upload files uploaded: ${parsed.values.fileInput.length}`);
    console.log("- covered input types: hidden, text, search, tel, url, email, password, number, date, month, week, time, datetime-local, color, range, checkbox, radio, file, submit, image, reset, button");
    console.log("- covered form components: form, fieldset, legend, label, textarea, select, optgroup, option, datalist, button, output, progress, meter, object");
    console.log("- hidden/button-like controls are present-only because browser_fill_form targets visible fillable controls");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    await client.close().catch(() => {});
    await bundle.close().catch(() => {});
  }
}

function assertEqual(actual, expected, label) {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`Expected ${label} to be ${expectedJson}, received ${actualJson}.`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
