import { z } from "zod";
import { defineTabTool } from "./tool.js";

export const uploadFile = defineTabTool({
  capability: "core",
  schema: {
    name: "browser_file_upload",
    title: "Upload files",
    description: "Upload one or multiple files",
    inputSchema: z.object({
      paths: z.array(z.string()).optional().describe(
        "The absolute paths to the files to upload. Can be single file or multiple files. If omitted, file chooser is cancelled."
      )
    }),
    listedInputSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        paths: {
          type: "array",
          items: { type: "string" },
          description: "The absolute paths to the files to upload. Can be single file or multiple files. If omitted, file chooser is cancelled."
        }
      },
      additionalProperties: false
    },
    type: "action"
  },
  clearsModalState: "fileChooser",

  handle: async (tab, params, response) => {
    response.setIncludeSnapshot();
    response.addCode(`await fileChooser.setFiles(${JSON.stringify(params.paths)});`);
    await tab.waitForCompletion(async () => {
      await tab.uploadFile(params.paths);
    });
    response.addTextResult(params.paths
      ? `Uploaded ${params.paths.length} file(s).`
      : "File chooser cancelled.");
  }
});

export default [
  uploadFile
];
