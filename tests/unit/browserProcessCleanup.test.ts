import { execFile } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  execFile: vi.fn()
}));

describe("browser process cleanup", () => {
  let killSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(execFile).mockReset();
    killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
  });

  afterEach(() => {
    killSpy.mockRestore();
    vi.useRealTimers();
  });

  it("cleans local test browser process trees only", async () => {
    vi.mocked(execFile).mockImplementation((_file, _args, callback) => {
      callback(
        null,
        [
          "101 1 /Applications/Firefox.app/Contents/MacOS/firefox -profile /var/folders/roxybrowser-bidi-a --remote-debugging-port=1234",
          "102 101 /Applications/Firefox.app/Contents/MacOS/plugin-container child",
          "201 1 /Applications/Firefox.app/Contents/MacOS/firefox -profile /Users/me/default",
          "301 1 /Applications/Chromium.app/Contents/MacOS/Chromium --user-data-dir=/tmp/roxybrowser-cdp-a --remote-debugging-port=0",
          "302 301 /Applications/Chromium.app/Contents/MacOS/Chromium --type=renderer"
        ].join("\n")
      );
      return undefined as never;
    });

    const { cleanupLocalTestBrowserProcesses } = await import("../helpers/browser-process-cleanup.js");
    const cleanup = cleanupLocalTestBrowserProcesses();

    await vi.advanceTimersByTimeAsync(500);
    await cleanup;

    expect(killSpy).toHaveBeenCalledWith(101, "SIGTERM");
    expect(killSpy).toHaveBeenCalledWith(102, "SIGTERM");
    expect(killSpy).toHaveBeenCalledWith(301, "SIGTERM");
    expect(killSpy).toHaveBeenCalledWith(302, "SIGTERM");
    expect(killSpy).toHaveBeenCalledWith(101, "SIGKILL");
    expect(killSpy).toHaveBeenCalledWith(102, "SIGKILL");
    expect(killSpy).toHaveBeenCalledWith(301, "SIGKILL");
    expect(killSpy).toHaveBeenCalledWith(302, "SIGKILL");
    expect(killSpy).not.toHaveBeenCalledWith(201, expect.anything());
  });
});
