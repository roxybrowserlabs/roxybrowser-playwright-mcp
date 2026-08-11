import { z } from "zod";
import { defineTool } from "./tool.js";

const configShow = defineTool({
  capability: "config",
  schema: {
    name: "browser_get_config",
    title: "Get config",
    description: "Get the final resolved config after merging CLI options, environment variables and config file.",
    inputSchema: z.object({}),
    type: "readOnly"
  },
  handle: async (context, _params, response) => {
    response.addTextResult(JSON.stringify(context.config, null, 2));
  }
});

export default [configShow];
