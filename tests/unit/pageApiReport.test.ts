import { describe, expect, it } from "vitest";
import {
  generateApiMethodSignatureReport,
  generateApiSurfaceReport,
  generatePageApiReport
} from "../../src/pageApiReport.js";

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

  it.each(["ElementHandle", "FrameLocator", "JSHandle", "Locator"])(
    "tracks the upstream Playwright %s gap against our public type",
    (interfaceName) => {
      const report = generateApiSurfaceReport(interfaceName);

      expect(report.missingMethods).toEqual([]);
      expect(report.missingProperties).toEqual([]);
      expect(report.extraMethods).toEqual([]);
      expect(report.extraProperties).toEqual([]);
    }
  );

  it.each(["Page", "Frame", "ElementHandle"])(
    "matches upstream Playwright selector overload signatures for %s",
    (interfaceName) => {
      const report = generateApiMethodSignatureReport(interfaceName, [
        "$",
        "$$",
        "$eval",
        "$$eval",
        "waitForSelector"
      ]);

      expect(report.currentMethodSignatures).toEqual(report.upstreamMethodSignatures);
    }
  );

  it.each(["Page", "Frame", "Locator", "FrameLocator"])(
    "matches upstream Playwright locator signatures for %s",
    (interfaceName) => {
      const report = generateApiMethodSignatureReport(interfaceName, ["locator"]);

      expect(report.currentMethodSignatures).toEqual(report.upstreamMethodSignatures);
    }
  );

  it.each(["Page", "Frame"])(
    "matches upstream Playwright waitForFunction signatures for %s",
    (interfaceName) => {
      const report = generateApiMethodSignatureReport(interfaceName, ["waitForFunction"]);

      expect(report.currentMethodSignatures).toEqual(report.upstreamMethodSignatures);
    }
  );

  it("matches upstream Playwright Page routing signatures", () => {
    const report = generateApiMethodSignatureReport("Page", [
      "route",
      "routeFromHAR",
      "routeWebSocket",
      "unroute",
      "unrouteAll"
    ]);

    expect(report.currentMethodSignatures).toEqual(report.upstreamMethodSignatures);
  });

  it("matches upstream Playwright Page misc signatures", () => {
    const report = generateApiMethodSignatureReport("Page", [
      "addLocatorHandler",
      "consoleMessages",
      "opener",
      "pageErrors",
      "requests",
      "screenshot",
      "video",
      "viewportSize"
    ]);

    expect(report.currentMethodSignatures).toEqual(report.upstreamMethodSignatures);
  });

  it("matches upstream Playwright Page waitForEvent signatures", () => {
    const report = generateApiMethodSignatureReport("Page", ["waitForEvent"]);

    expect(report.currentMethodSignatures).toEqual(report.upstreamMethodSignatures);
  });

  it("matches upstream Playwright Page event listener signatures", () => {
    const report = generateApiMethodSignatureReport("Page", [
      "on",
      "once",
      "addListener",
      "removeListener",
      "off",
      "prependListener"
    ]);

    expect(report.currentMethodSignatures).toEqual(report.upstreamMethodSignatures);
  });

  it("matches upstream Playwright Page navigation and waiting signatures", () => {
    const report = generateApiMethodSignatureReport("Page", [
      "goBack",
      "goForward",
      "goto",
      "reload",
      "setContent",
      "waitForLoadState",
      "waitForNavigation",
      "waitForRequest",
      "waitForResponse",
      "waitForURL"
    ]);

    expect(report.currentMethodSignatures).toEqual(report.upstreamMethodSignatures);
  });

  it("matches upstream Playwright Page action signatures", () => {
    const report = generateApiMethodSignatureReport("Page", [
      "check",
      "click",
      "dblclick",
      "fill",
      "hover",
      "press",
      "setChecked",
      "tap",
      "type",
      "uncheck"
    ]);

    expect(report.currentMethodSignatures).toEqual(report.upstreamMethodSignatures);
  });

  it("matches upstream Playwright Page selector query and state signatures", () => {
    const report = generateApiMethodSignatureReport("Page", [
      "focus",
      "getAttribute",
      "innerHTML",
      "innerText",
      "inputValue",
      "isChecked",
      "isDisabled",
      "isEditable",
      "isEnabled",
      "isHidden",
      "isVisible",
      "textContent"
    ]);

    expect(report.currentMethodSignatures).toEqual(report.upstreamMethodSignatures);
  });

  it("matches upstream Playwright Page locator and small misc signatures", () => {
    const report = generateApiMethodSignatureReport("Page", [
      "close",
      "frame",
      "getByAltText",
      "getByLabel",
      "getByPlaceholder",
      "getByRole",
      "getByText",
      "getByTitle",
      "removeAllListeners",
      "setExtraHTTPHeaders",
      "setViewportSize"
    ]);

    expect(report.currentMethodSignatures).toEqual(report.upstreamMethodSignatures);
  });

  it("matches upstream Playwright Page remaining signatures", () => {
    const report = generateApiMethodSignatureReport("Page", [
      "addInitScript",
      "addScriptTag",
      "addStyleTag",
      "ariaSnapshot",
      "dispatchEvent",
      "dragAndDrop",
      "emulateMedia",
      "exposeBinding",
      "pdf",
      "selectOption",
      "setInputFiles"
    ]);

    expect(report.currentMethodSignatures).toEqual(report.upstreamMethodSignatures);
  });

  it("matches upstream Playwright ElementHandle state and convenience signatures", () => {
    const report = generateApiMethodSignatureReport("ElementHandle", [
      "boundingBox",
      "contentFrame",
      "getAttribute",
      "innerHTML",
      "innerText",
      "inputValue",
      "isChecked",
      "isDisabled",
      "isEditable",
      "isEnabled",
      "isHidden",
      "isVisible",
      "ownerFrame",
      "selectText",
      "textContent",
      "waitForElementState"
    ]);

    expect(report.currentMethodSignatures).toEqual(report.upstreamMethodSignatures);
  });
});
