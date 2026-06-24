import { afterEach, describe, expect, it, vi } from "vitest";

describe("roxybrowser firefox bidi cleanup script", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    delete process.env.ROXYBROWSER_API_TOKEN;
  });

  it("opens a Firefox bidi profile and returns dirId/endpoint/sessionId/created metadata", async () => {
    process.env.ROXYBROWSER_API_TOKEN = "token";

    const browserDetail = vi.fn(async (_workspaceId: number, dirId: string) => ({
      data: {
        dirId,
        windowRemark: "firefox bidi e2e worker-1",
        coreType: "Firefox",
        coreVersion: "146"
      }
    }));

    class RoxyClientMock {
      workspace_project = vi.fn(async () => ({
        data: [{ id: 1, project_details: [{ projectId: 2 }] }]
      }));

      browser_list = vi.fn(async () => ({
        data: [{ dirId: "worker-profile" }]
      }));

      browser_detail = browserDetail;
      browser_open = vi.fn(async (dirId: string) => ({
        data: { dirId, ws: "ws://127.0.0.1:9222/session/existing-bidi-session" }
      }));
      browser_close = vi.fn(async () => ({ code: 0 }));
      browser_connection_info = vi.fn(async () => ({ data: [] }));
    }

    vi.doMock("../../tests/helpers/roxybrowser-openai.mjs", () => ({
      RoxyClient: RoxyClientMock
    }));

    const script = await import("../../scripts/roxybrowser-firefox-bidi.mjs");
    const session = await script.openRoxyBrowserFirefoxBidiProfile({
      profileName: "RoxyBrowser Firefox BiDi E2E [worker 1]",
      windowRemark: "firefox bidi e2e worker-1"
    });

    expect(session).toEqual({
      dirId: "worker-profile",
      endpoint: "ws://127.0.0.1:9222/session/existing-bidi-session",
      sessionId: "existing-bidi-session",
      created: false
    });
  });

  it("closes and deletes an explicitly provided Firefox bidi profile dirId without sweeping other profiles", async () => {
    process.env.ROXYBROWSER_API_TOKEN = "token";
    process.env.ROXYBROWSER_WORKSPACE_ID = "1";

    const browserClose = vi.fn(async () => ({ code: 0 }));
    const browserDelete = vi.fn(async () => ({ code: 0 }));

    class RoxyClientMock {
      workspace_project = vi.fn(async () => ({
        data: [{ id: 1, project_details: [{ projectId: 2 }] }]
      }));

      browser_list = vi.fn(async () => ({
        data: [
          { dirId: "worker-profile" },
          { dirId: "other-profile" }
        ]
      }));

      browser_detail = vi.fn();
      browser_open = vi.fn();
      browser_close = browserClose;
      browser_delete = browserDelete;
      browser_connection_info = vi.fn(async () => ({ data: [] }));
    }

    vi.doMock("../../tests/helpers/roxybrowser-openai.mjs", () => ({
      RoxyClient: RoxyClientMock
    }));

    const script = await import("../../scripts/roxybrowser-firefox-bidi.mjs");
    await script.closeRoxyBrowserFirefoxBidiProfile({
      workspaceId: "1",
      dirId: "worker-profile",
      deleteProfile: true
    });

    expect(browserClose).toHaveBeenCalledTimes(1);
    expect(browserClose).toHaveBeenCalledWith("worker-profile");
    expect(browserClose).not.toHaveBeenCalledWith("other-profile");
    expect(browserDelete).toHaveBeenCalledTimes(1);
    expect(browserDelete).toHaveBeenCalledWith(1, "worker-profile");
  });
});
