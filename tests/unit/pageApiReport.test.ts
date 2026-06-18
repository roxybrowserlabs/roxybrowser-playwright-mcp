import { describe, expect, it } from "vitest";
import { generatePageApiReport } from "../../src/pageApiReport.js";

describe("generatePageApiReport", () => {
  it("tracks the upstream Playwright Page gap against our public Page type", () => {
    const report = generatePageApiReport();

    expect(report.missingMethods).toEqual([]);
    expect(report.missingProperties).toEqual([]);
    expect(report.currentMethods).toContain("frame");
    expect(report.currentMethods).toContain("frames");
    expect(report.currentMethods).toContain("addScriptTag");
    expect(report.currentMethods).toContain("bringToFront");
    expect(report.currentMethods).toContain("dragAndDrop");
    expect(report.currentMethods).toContain("evaluateHandle");
    expect(report.currentMethods).toContain("emulateMedia");
    expect(report.currentMethods).toContain("opener");
    expect(report.currentMethods).toContain("pause");
    expect(report.currentMethods).toContain("waitForFunction");
    expect(report.currentMethods).toContain("route");
    expect(report.currentMethods).toContain("routeFromHAR");
    expect(report.currentMethods).toContain("routeWebSocket");
    expect(report.currentMethods).toContain("setInputFiles");
    expect(report.currentMethods).toContain("unroute");
    expect(report.currentMethods).toContain("unrouteAll");
    expect(report.currentMethods).toContain("video");
    expect(report.currentMethods).toContain("workers");
    expect(report.currentProperties).toContain("keyboard");
    expect(report.currentProperties).toContain("localStorage");
    expect(report.currentProperties).toContain("mouse");
    expect(report.currentProperties).toContain("request");
    expect(report.currentProperties).toContain("sessionStorage");
    expect(report.currentProperties).toContain("touchscreen");
    expect(report.extraMethods).toEqual([]);
    expect(report.extraProperties).toEqual([]);
  });
});
