import { writeFile } from "node:fs/promises";
import { z } from "zod";
import { defineTabTool } from "./tool.js";

const pdf = defineTabTool({
  capability: "pdf",
  schema: {
    name: "browser_pdf_save",
    title: "Save as PDF",
    description: "Save page as PDF",
    inputSchema: z.object({
      filename: z.string().optional().describe("File name to save the pdf to. Defaults to `page-{timestamp}.pdf` if not specified. Prefer relative file names to stay within the output directory.")
    }),
    type: "readOnly"
  },

  handle: async (tab, params, response) => {
    const data = await tab.context.runtime.pdf();
    const resolvedFilename = await tab.context.resolveOutputFile(
      params.filename?.trim() || `page-${new Date().toISOString().replace(/[:.]/g, "-")}.pdf`,
      "pdf"
    );
    await writeFile(resolvedFilename, data);
    tab.context.markWrittenFile(resolvedFilename);
    response.addFileLink("Page as pdf", resolvedFilename);
    response.addCode(`await page.pdf({ path: '${resolvedFilename.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}' });`);
  }
});

export default [
  pdf
];
