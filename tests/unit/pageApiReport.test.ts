import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  generateApiMethodSignatureReport,
  generateApiSurfaceReport,
  generatePageApiReport
} from "../../src/pageApiReport.js";

const currentApiTypes = () => readFileSync("src/types/api.ts", "utf8");
const currentIndexTypes = () => readFileSync("src/index.ts", "utf8");
const currentOptionsTypes = () => readFileSync("src/types/options.ts", "utf8");

describe("generatePageApiReport", () => {
  it.each(["Page", "Frame", "Locator", "FrameLocator", "ElementHandle", "JSHandle"])(
    "matches upstream Playwright full API surface signatures for %s",
    (interfaceName) => {
      const report = generateApiSurfaceReport(interfaceName);
      const normalize = (signature: string) =>
        signature
          .replace(/\{\s*,/g, "{")
          .replace(/,\s*\}/g, " }")
          .replace(/\s+/g, " ")
          .trim();
      const normalizedCurrentMethodSignatures = Object.fromEntries(
        Object.entries(report.currentMethodSignatures).map(([methodName, signatures]) => [
          methodName,
          signatures.map(normalize)
        ])
      );

      expect(report.missingMethods).toEqual([]);
      expect(report.extraMethods).toEqual([]);
      expect(report.missingProperties).toEqual([]);
      expect(report.extraProperties).toEqual([]);
      expect(normalizedCurrentMethodSignatures).toEqual(report.upstreamMethodSignatures);
    }
  );

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

  it("matches upstream Playwright APIRequestContext properties used by page.request", () => {
    const report = generateApiSurfaceReport("APIRequestContext");

    expect(report.missingProperties).toEqual([]);
    expect(report.extraProperties).toEqual([]);
    expect(report.currentProperties).toContain("tracing");
  });

  it("matches upstream Playwright FileChooser.setFiles signature", () => {
    const report = generateApiMethodSignatureReport("FileChooser", ["setFiles"]);

    expect(report.currentMethodSignatures).toEqual(report.upstreamMethodSignatures);
  });

  it("matches upstream Playwright Download.createReadStream signature", () => {
    const report = generateApiMethodSignatureReport("Download", ["createReadStream"]);

    expect(report.currentMethodSignatures).toEqual(report.upstreamMethodSignatures);
  });

  it("exports ConsoleMessage by the upstream Playwright name", () => {
    expect(currentIndexTypes()).toMatch(/\bConsoleMessage\b/);
  });

  it("does not expose legacy waitForSelector waitFor option publicly", () => {
    expect(currentOptionsTypes()).not.toContain("waitFor?: WaitForSelectorState");
  });

  it("matches upstream Playwright Disposable async-dispose surface", () => {
    const disposableSource = currentApiTypes().match(/export interface Disposable \{[\s\S]*?\n\}/)?.[0] ?? "";

    expect(disposableSource).toContain("dispose(): Promise<void>;");
    expect(disposableSource).toContain("[Symbol.asyncDispose](): Promise<void>;");
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

  it.each(["Page", "Frame", "ElementHandle", "JSHandle"])(
    "matches upstream Playwright evaluate signatures for %s",
    (interfaceName) => {
      const report = generateApiMethodSignatureReport(interfaceName, [
        "evaluate",
        "evaluateHandle"
      ]);

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
      "waitForTimeout",
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

  it("does not expose human extensions on Page action signatures", () => {
    const report = generateApiSurfaceReport("Page");
    const actionSignatures = Object.values(report.currentMethodSignatures)
      .flat()
      .filter((signature) => /^(click|dblclick|fill|hover|press|tap)\(/.test(signature));

    expect(actionSignatures.some((signature) => signature.includes("human?: HumanizationOptions"))).toBe(false);
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
      "textContent",
      "title"
    ]);

    expect(report.currentMethodSignatures).toEqual(report.upstreamMethodSignatures);
  });

  it("matches upstream Playwright Frame selector query and state signatures", () => {
    const report = generateApiMethodSignatureReport("Frame", [
      "addScriptTag",
      "addStyleTag",
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

  it("matches upstream Playwright Frame action signatures", () => {
    const report = generateApiMethodSignatureReport("Frame", [
      "check",
      "click",
      "dblclick",
      "dragAndDrop",
      "fill",
      "hover",
      "press",
      "selectOption",
      "setChecked",
      "tap",
      "type",
      "uncheck"
    ]);

    expect(report.currentMethodSignatures).toEqual(report.upstreamMethodSignatures);
  });

  it("does not expose human extensions on Frame and Locator action signatures", () => {
    const frameReport = generateApiSurfaceReport("Frame");
    const locatorReport = generateApiSurfaceReport("Locator");
    const frameActionSignatures = Object.values(frameReport.currentMethodSignatures)
      .flat()
      .filter((signature) => /^(click|dblclick|fill|hover|press|tap)\(/.test(signature));
    const locatorActionSignatures = Object.values(locatorReport.currentMethodSignatures)
      .flat()
      .filter((signature) => /^(click|dblclick|fill|hover|press|tap)\(/.test(signature));

    expect(frameActionSignatures.some((signature) => signature.includes("human?: HumanizationOptions"))).toBe(false);
    expect(locatorActionSignatures.some((signature) => signature.includes("human?: HumanizationOptions"))).toBe(false);
  });

  it("matches upstream Playwright Frame remaining forwarded signatures", () => {
    const report = generateApiMethodSignatureReport("Frame", [
      "childFrames",
      "frameElement",
      "isDetached",
      "name",
      "page",
      "parentFrame",
      "setInputFiles",
      "waitForTimeout"
    ]);

    expect(report.currentMethodSignatures).toEqual(report.upstreamMethodSignatures);
  });

  it("matches upstream Playwright Page locator and small misc signatures", () => {
    const report = generateApiMethodSignatureReport("Page", [
      "cancelPickLocator",
      "clearConsoleMessages",
      "clearPageErrors",
      "close",
      "content",
      "context",
      "frame",
      "frameLocator",
      "getByAltText",
      "getByLabel",
      "getByPlaceholder",
      "getByRole",
      "getByTestId",
      "getByText",
      "getByTitle",
      "hideHighlight",
      "isClosed",
      "mainFrame",
      "pickLocator",
      "removeAllListeners",
      "removeLocatorHandler",
      "requestGC",
      "setDefaultNavigationTimeout",
      "setDefaultTimeout",
      "setExtraHTTPHeaders",
      "setViewportSize",
      "url"
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
      "exposeFunction",
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
      "scrollIntoViewIfNeeded",
      "textContent",
      "waitForElementState"
    ]);

    expect(report.currentMethodSignatures).toEqual(report.upstreamMethodSignatures);
  });

  it("matches upstream Playwright JSHandle small method signatures", () => {
    const report = generateApiMethodSignatureReport("JSHandle", [
      "asElement",
      "dispose",
      "getProperties",
      "getProperty",
      "jsonValue"
    ]);

    expect(report.currentMethodSignatures).toEqual(report.upstreamMethodSignatures);
  });

  it("matches upstream Playwright FrameLocator remaining signatures", () => {
    const report = generateApiMethodSignatureReport("FrameLocator", [
      "first",
      "last",
      "nth",
      "owner"
    ]);

    expect(report.currentMethodSignatures).toEqual(report.upstreamMethodSignatures);
  });

  it("matches upstream Playwright Locator composition and list signatures", () => {
    const report = generateApiMethodSignatureReport("Locator", [
      "all",
      "allInnerTexts",
      "allTextContents",
      "and",
      "blur",
      "count",
      "description",
      "describe",
      "elementHandles",
      "filter",
      "first",
      "highlight",
      "last",
      "normalize",
      "nth",
      "or",
      "toString",
      "waitFor"
    ]);

    expect(report.currentMethodSignatures).toEqual(report.upstreamMethodSignatures);
  });

  it("matches upstream Playwright Locator evaluation and action signatures", () => {
    const report = generateApiMethodSignatureReport("Locator", [
      "clear",
      "dragTo",
      "drop",
      "elementHandle",
      "evaluateAll",
      "pressSequentially"
    ]);

    expect(report.currentMethodSignatures).toEqual(report.upstreamMethodSignatures);
  });
});
