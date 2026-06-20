import { afterEach, describe, expect, it, vi } from "vitest";

describe("roxybrowser firefox bidi cleanup script", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    delete process.env.ROXYBROWSER_API_TOKEN;
  });

  it("closes every matching Firefox bidi profile, not just the cached one", async () => {
    process.env.ROXYBROWSER_API_TOKEN = "token";

    const browserClose = vi.fn(async () => ({ code: 0 }));
    const browserConnectionInfo = vi.fn(async () => ({ data: [] }));
    const browserDetail = vi.fn(async (_workspaceId: number, dirId: string) => ({
      data: {
        dirId,
        windowRemark: dirId === "other-profile" ? "some other window" : "firefox bidi e2e",
        coreType: "Firefox",
        coreVersion: "146"
      }
    }));

    class RoxyClientMock {
      workspace_project = vi.fn(async () => ({
        data: [{ id: 1, project_details: [{ projectId: 2 }] }]
      }));

      browser_list = vi.fn(async () => ({
        data: [
          { dirId: "cached-profile" },
          { dirId: "stale-profile" },
          { dirId: "other-profile" }
        ]
      }));

      browser_detail = browserDetail;
      browser_open = vi.fn(async (dirId: string) => ({
        data: { dirId, ws: "ws://127.0.0.1:9222/session" }
      }));
      browser_close = browserClose;
      browser_connection_info = browserConnectionInfo;
    }

    vi.doMock("../../tests/helpers/roxybrowser-openai.mjs", () => ({
      RoxyClient: RoxyClientMock
    }));

    const script = await import("../../scripts/roxybrowser-firefox-bidi.mjs");

    await script.resolveRoxyBrowserFirefoxBidiEndpoint();
    await script.closeRoxyBrowserFirefoxBidiProfile();

    expect(browserClose).toHaveBeenCalledTimes(2);
    expect(browserClose).toHaveBeenNthCalledWith(1, "cached-profile");
    expect(browserClose).toHaveBeenNthCalledWith(2, "stale-profile");
    expect(browserClose).not.toHaveBeenCalledWith("other-profile");
  });
});
