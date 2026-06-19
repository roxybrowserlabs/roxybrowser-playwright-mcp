import { afterEach, describe, expect, it, vi } from "vitest";
import { RoxyClient } from "../helpers/roxybrowser-openai.mjs";

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
});
