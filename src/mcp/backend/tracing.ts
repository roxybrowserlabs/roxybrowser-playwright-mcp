import { z } from "zod";
import { defineTool } from "./tool.js";

const tracingStart = defineTool({
  capability: "devtools",
  schema: {
    name: "browser_start_tracing",
    title: "Start tracing",
    description: "Start trace recording",
    inputSchema: z.object({}),
    type: "readOnly"
  },
  handle: async (context, _params, response) => {
    const trace = await context.runtime.startTracing();
    response.addTextResult("Trace recording started");
    response.addFileLink("Action log", `${trace.tracesDir}/${trace.name}.trace`);
    response.addFileLink("Network log", `${trace.tracesDir}/${trace.name}.network`);
    response.addFileLink("Resources", `${trace.tracesDir}/resources`);
  }
});

const tracingStop = defineTool({
  capability: "devtools",
  schema: {
    name: "browser_stop_tracing",
    title: "Stop tracing",
    description: "Stop trace recording",
    inputSchema: z.object({}),
    type: "readOnly"
  },
  handle: async (context, _params, response) => {
    const trace = await context.runtime.stopTracing();
    response.addTextResult("Trace recording stopped.");
    response.addFileLink("Trace", `${trace.tracesDir}/${trace.name}.trace`);
    response.addFileLink("Network log", `${trace.tracesDir}/${trace.name}.network`);
    response.addFileLink("Resources", `${trace.tracesDir}/resources`);
  }
});

export default [
  tracingStart,
  tracingStop
];
