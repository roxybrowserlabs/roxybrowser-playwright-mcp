import { afterEach, describe, expect, it, vi } from "vitest";
import { RoxyClient } from "../../scripts/roxybrowser-client.mjs";

describe("RoxyClient", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("aborts hung API requests with a real fetch signal timeout", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation((_url, init) => {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        });
      });

    const client = new RoxyClient("50000", "token");
    client.timeoutMs = 1;

    await expect(client.health()).rejects.toThrow(
      "RoxyBrowser API request timed out after 1ms"
    );
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://127.0.0.1:50000/health",
      expect.objectContaining({
        signal: expect.any(AbortSignal)
      })
    );
  });

  it("maps the legacy browser_open helper through the typed OpenAPI client transport", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({
        code: 0,
        msg: "ok",
        data: { ws: "ws://127.0.0.1:9222/devtools/browser/test" }
      })));

    const client = new RoxyClient("50001", "token");
    await expect(client.browser_open("profile-1", ["--flag"], { forceOpen: true })).resolves.toEqual({
      code: 0,
      msg: "ok",
      data: { ws: "ws://127.0.0.1:9222/devtools/browser/test" }
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      "http://127.0.0.1:50001/browser/open",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          dirId: "profile-1",
          args: ["--flag"],
          forceOpen: true
        }),
        headers: expect.objectContaining({
          token: "token"
        })
      })
    );
  });

  it("keeps workspace lookup on the SDK workspace endpoint without legacy hand-written fetch code", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({
        code: 0,
        msg: "ok",
        data: { total: 1, rows: [{ id: 12 }] }
      })));

    const client = new RoxyClient("50002", "token");
    await expect(client.workspace_project()).resolves.toEqual({
      code: 0,
      msg: "ok",
      data: { total: 1, rows: [{ id: 12 }] }
    });

    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe("http://127.0.0.1:50002/browser/workspace");
  });
});
