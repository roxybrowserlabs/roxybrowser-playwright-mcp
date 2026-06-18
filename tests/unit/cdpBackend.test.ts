import { describe, expect, it } from "vitest";
import {
  buildChromiumLaunchArgs,
  resolveExecutableCandidates
} from "../../src/protocol/cdp/backend.js";

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

describe("buildChromiumLaunchArgs", () => {
  it("uses no startup window for non-persistent launches", () => {
    expect(buildChromiumLaunchArgs({ headless: false }, "/tmp/roxy-profile")).toEqual([
      "--user-data-dir=/tmp/roxy-profile",
      "--remote-debugging-port=0",
      "--disable-background-networking",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-popup-blocking",
      "--disable-renderer-backgrounding",
      "--no-first-run",
      "--no-default-browser-check",
      "--no-startup-window"
    ]);
  });

  it("keeps headless launches windowless without adding about:blank", () => {
    expect(buildChromiumLaunchArgs({ headless: true }, "/tmp/roxy-profile")).toEqual([
      "--user-data-dir=/tmp/roxy-profile",
      "--remote-debugging-port=0",
      "--disable-background-networking",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-popup-blocking",
      "--disable-renderer-backgrounding",
      "--no-first-run",
      "--no-default-browser-check",
      "--no-startup-window",
      "--headless=new"
    ]);
  });

  it("appends custom browser args after the default launch args", () => {
    expect(
      buildChromiumLaunchArgs(
        {
          headless: false,
          args: ["--start-maximized", "--lang=en-US"]
        },
        "/tmp/roxy-profile"
      )
    ).toEqual([
      "--user-data-dir=/tmp/roxy-profile",
      "--remote-debugging-port=0",
      "--disable-background-networking",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-popup-blocking",
      "--disable-renderer-backgrounding",
      "--no-first-run",
      "--no-default-browser-check",
      "--no-startup-window",
      "--start-maximized",
      "--lang=en-US"
    ]);
  });
});
