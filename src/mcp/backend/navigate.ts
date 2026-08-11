import { z } from "zod";
import { defineTool } from "./tool.js";

const navigate = defineTool({
  capability: "core-navigation",
  schema: {
    name: "browser_navigate",
    title: "Navigate to a URL",
    description: "Navigate to a URL",
    inputSchema: z.object({
      url: z.string().describe("The URL to navigate to")
    }),
    type: "action"
  },
  handle: async (context, params, response) => {
    await context.ensureTab();
    await context.runtime.navigate(params.url);
    response.setIncludeSnapshot();
    response.addCode(`await page.goto('${params.url.startsWith("http") ? params.url : params.url.startsWith("localhost") ? `http://${params.url}` : `https://${params.url}`}');`);
  }
});

const goBack = defineTool({
  capability: "core-navigation",
  schema: {
    name: "browser_navigate_back",
    title: "Go back",
    description: "Go back to the previous page in the history",
    inputSchema: z.object({}),
    type: "action"
  },
  handle: async (context, _params, response) => {
    await context.runtime.goBack();
    response.setIncludeSnapshot();
    response.addCode("await page.goBack();");
  }
});

const goForward = defineTool({
  capability: "core-navigation",
  skillOnly: true,
  schema: {
    name: "browser_navigate_forward",
    title: "Go forward",
    description: "Go forward to the next page in the history",
    inputSchema: z.object({}),
    type: "action"
  },
  handle: async (context, _params, response) => {
    await context.runtime.goForward();
    response.setIncludeSnapshot();
    response.addCode("await page.goForward();");
  }
});

const reload = defineTool({
  capability: "core-navigation",
  skillOnly: true,
  schema: {
    name: "browser_reload",
    title: "Reload the page",
    description: "Reload the current page",
    inputSchema: z.object({}),
    type: "action"
  },
  handle: async (context, _params, response) => {
    await context.runtime.reload();
    response.setIncludeSnapshot();
    response.addCode("await page.reload();");
  }
});

const waitFor = defineTool({
  capability: "core-navigation",
  schema: {
    name: "browser_wait_for",
    title: "Wait for",
    description: "Wait for text to appear or disappear or a specified time to pass",
    inputSchema: z.object({
      time: z.number().optional().describe("The time to wait in seconds"),
      text: z.string().optional().describe("The text to wait for"),
      textGone: z.string().optional().describe("The text to wait for to disappear")
    }),
    type: "action"
  },
  handle: async (context, params, response) => {
    if (!params.text && !params.textGone && !params.time) {
      throw new Error("Either time, text or textGone must be provided");
    }
    const waitSeconds = params.time;
    if (waitSeconds !== undefined) {
      response.addCode(`await new Promise(f => setTimeout(f, ${waitSeconds} * 1000));`);
      await new Promise((resolve) => setTimeout(resolve, Math.min(30_000, waitSeconds * 1000)));
    }
    if (params.textGone !== undefined) {
      response.addCode(`await page.getByText(${JSON.stringify(params.textGone)}).first().waitFor({ state: 'hidden' });`);
      await context.runtime.waitFor({ textGone: params.textGone }, 5000);
    }
    if (params.text !== undefined) {
      response.addCode(`await page.getByText(${JSON.stringify(params.text)}).first().waitFor({ state: 'visible' });`);
      await context.runtime.waitFor({ text: params.text }, 5000);
    }
    response.addTextResult(`Waited for ${params.text || params.textGone || params.time}`);
    response.setIncludeSnapshot();
  }
});

export default [navigate, goBack, goForward, reload, waitFor];
