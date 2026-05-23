import { describe, expect, it } from "vitest";
import { resolveExecutableCandidates } from "../../src/protocol/cdp/backend.js";

describe("resolveExecutableCandidates", () => {
  it("prefers executablePath over channel", () => {
    expect(
      resolveExecutableCandidates(
        {
          channel: "chrome",
          executablePath: "/custom/browser"
        },
        "darwin"
      )
    ).toEqual(["/custom/browser"]);
  });

  it("resolves the requested Chrome channel on macOS", () => {
    expect(resolveExecutableCandidates({ channel: "chrome" }, "darwin")).toEqual([
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    ]);
  });

  it("resolves the requested Edge channel on macOS", () => {
    expect(resolveExecutableCandidates({ channel: "msedge-dev" }, "darwin")).toEqual([
      "/Applications/Microsoft Edge Dev.app/Contents/MacOS/Microsoft Edge Dev"
    ]);
  });

  it("falls back to the default Chromium-family candidates when no override is provided", () => {
    expect(resolveExecutableCandidates({}, "darwin")).toEqual([
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
    ]);
  });

  it("throws for unsupported channels on the current platform", () => {
    expect(() =>
      resolveExecutableCandidates({ channel: "chrome-canary" }, "linux")
    ).toThrow('Unsupported browser channel "chrome-canary" for platform "linux".');
  });
});
