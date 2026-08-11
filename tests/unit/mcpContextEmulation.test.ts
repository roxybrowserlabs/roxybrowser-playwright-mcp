import { describe, expect, it } from "vitest";
import { emulateBidiContext, emulateCdpContext } from "../../src/mcp/contextEmulation.js";

describe("MCP context emulation", () => {
  it("maps Playwright mobile device context options to Chromium CDP emulation calls", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    await emulateCdpContext(
      {
        Emulation: {
          async setDeviceMetricsOverride(params) {
            calls.push({ method: "Emulation.setDeviceMetricsOverride", params });
          },
          async setTouchEmulationEnabled(params) {
            calls.push({ method: "Emulation.setTouchEmulationEnabled", params });
          },
          async setUserAgentOverride(params) {
            calls.push({ method: "Emulation.setUserAgentOverride", params });
          }
        }
      },
      {
        viewport: { width: 360, height: 732 },
        screen: { width: 360, height: 808 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
        userAgent: "Mozilla/5.0 (Linux; Android 16; Pixel 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.7922.34 Mobile Safari/537.36"
      }
    );

    expect(calls).toEqual([
      {
        method: "Emulation.setDeviceMetricsOverride",
        params: {
          mobile: true,
          width: 360,
          height: 732,
          screenWidth: 360,
          screenHeight: 808,
          deviceScaleFactor: 3,
          screenOrientation: { angle: 0, type: "portraitPrimary" }
        }
      },
      {
        method: "Emulation.setTouchEmulationEnabled",
        params: { enabled: true }
      },
      {
        method: "Emulation.setUserAgentOverride",
        params: {
          userAgent: "Mozilla/5.0 (Linux; Android 16; Pixel 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.7922.34 Mobile Safari/537.36"
        }
      }
    ]);
  });

  it("maps Playwright ignoreHTTPSErrors context option to Chromium CDP security calls", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    await emulateCdpContext(
      {
        Security: {
          async setIgnoreCertificateErrors(params) {
            calls.push({ method: "Security.setIgnoreCertificateErrors", params });
          }
        }
      },
      {
        ignoreHTTPSErrors: true
      }
    );

    expect(calls).toEqual([
      {
        method: "Security.setIgnoreCertificateErrors",
        params: { ignore: true }
      }
    ]);
  });

  it("maps Playwright context permissions to Chromium CDP browser permissions", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    await emulateCdpContext(
      {},
      {
        permissions: ["geolocation", "clipboard-read", "clipboard-write", "local-network-access"]
      },
      {
        browserClient: {
          Browser: {
            async grantPermissions(params) {
              calls.push({ method: "Browser.grantPermissions", params });
            }
          }
        }
      }
    );

    expect(calls).toEqual([
      {
        method: "Browser.grantPermissions",
        params: {
          permissions: [
            "geolocation",
            "clipboardReadWrite",
            "clipboardSanitizedWrite",
            "localNetworkAccess",
            "localNetwork",
            "loopbackNetwork"
          ]
        }
      }
    ]);
  });

  it("rejects unknown Playwright context permissions for Chromium CDP", async () => {
    await expect(emulateCdpContext(
      {},
      {
        permissions: ["unknown-permission"]
      },
      {
        browserClient: {
          Browser: {
            async grantPermissions() {}
          }
        }
      }
    )).rejects.toThrow("Unknown permission: unknown-permission");
  });

  it("maps supported Playwright context options to Firefox BiDi emulation calls", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    await emulateBidiContext(
      {
        async browsingContextSetViewport(params) {
          calls.push({ method: "browsingContext.setViewport", params });
        },
        async emulationSetUserAgentOverride(params) {
          calls.push({ method: "emulation.setUserAgentOverride", params });
        }
      },
      "tab-1",
      {
        viewport: { width: 393, height: 659 },
        userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5 Mobile/15E148 Safari/604.1"
      }
    );

    expect(calls).toEqual([
      {
        method: "browsingContext.setViewport",
        params: {
          context: "tab-1",
          viewport: { width: 393, height: 659 }
        }
      },
      {
        method: "emulation.setUserAgentOverride",
        params: {
          userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5 Mobile/15E148 Safari/604.1",
          contexts: ["tab-1"]
        }
      }
    ]);
  });
});
