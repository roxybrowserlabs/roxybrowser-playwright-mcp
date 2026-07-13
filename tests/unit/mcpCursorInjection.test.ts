import { describe, expect, it, vi } from "vitest";
import { CURSOR_VISUALIZATION_INSTALL_SOURCE } from "../../src/human/bubbleCursor.js";
import { installCursorVisualizationInCdpPage } from "../../src/mcp/connectedBrowser.js";

describe("MCP cursor visualization injection", () => {
  it("installs the cursor in the current CDP document and every future document", async () => {
    const addScriptToEvaluateOnNewDocument = vi.fn(async () => ({ identifier: "cursor-script" }));
    const evaluate = vi.fn(async () => ({ result: { value: true } }));

    await installCursorVisualizationInCdpPage({
      Page: { addScriptToEvaluateOnNewDocument },
      Runtime: { evaluate }
    });

    expect(addScriptToEvaluateOnNewDocument).toHaveBeenCalledWith({
      source: CURSOR_VISUALIZATION_INSTALL_SOURCE
    });
    expect(evaluate).toHaveBeenCalledWith({
      expression: CURSOR_VISUALIZATION_INSTALL_SOURCE,
      returnByValue: true,
      awaitPromise: true
    });
  });
});
