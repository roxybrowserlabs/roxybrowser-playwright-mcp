import { execFile, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
  spawnSync: vi.fn()
}));

describe("browser process cleanup", () => {
  let killSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(execFile).mockReset();
    vi.mocked(spawnSync).mockReset();
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
    expect(killSpy).toHaveBeenCalledWith(-101, "SIGTERM");
    expect(killSpy).toHaveBeenCalledWith(102, "SIGTERM");
    expect(killSpy).toHaveBeenCalledWith(301, "SIGTERM");
    expect(killSpy).toHaveBeenCalledWith(-301, "SIGTERM");
    expect(killSpy).toHaveBeenCalledWith(302, "SIGTERM");
    expect(killSpy).toHaveBeenCalledWith(101, "SIGKILL");
    expect(killSpy).toHaveBeenCalledWith(-101, "SIGKILL");
    expect(killSpy).toHaveBeenCalledWith(102, "SIGKILL");
    expect(killSpy).toHaveBeenCalledWith(301, "SIGKILL");
    expect(killSpy).toHaveBeenCalledWith(-301, "SIGKILL");
    expect(killSpy).toHaveBeenCalledWith(302, "SIGKILL");
    expect(killSpy).not.toHaveBeenCalledWith(201, expect.anything());
  });

  it("rescans before force-killing local test browser process trees", async () => {
    vi.mocked(execFile)
      .mockImplementationOnce((_file, _args, callback) => {
        callback(
          null,
          "101 1 /Applications/Firefox.app/Contents/MacOS/firefox -profile /tmp/roxybrowser-bidi-a --remote-debugging-port=1234"
        );
        return undefined as never;
      })
      .mockImplementationOnce((_file, _args, callback) => {
        callback(
          null,
          [
            "111 1 /Applications/Firefox.app/Contents/MacOS/firefox -profile /tmp/roxybrowser-bidi-a --remote-debugging-port=1234",
            "112 111 /Applications/Firefox.app/Contents/MacOS/plugin-container child"
          ].join("\n")
        );
        return undefined as never;
      });

    const { cleanupLocalTestBrowserProcesses } = await import("../helpers/browser-process-cleanup.js");
    const cleanup = cleanupLocalTestBrowserProcesses();

    await vi.advanceTimersByTimeAsync(500);
    await cleanup;

    expect(killSpy).toHaveBeenCalledWith(-101, "SIGTERM");
    expect(killSpy).toHaveBeenCalledWith(101, "SIGTERM");
    expect(killSpy).toHaveBeenCalledWith(-111, "SIGKILL");
    expect(killSpy).toHaveBeenCalledWith(111, "SIGKILL");
    expect(killSpy).toHaveBeenCalledWith(112, "SIGKILL");
  });

  it("synchronously cleans local test browser process trees on process exit", async () => {
    vi.mocked(spawnSync).mockReturnValue({
      stdout: [
        "701 1 /Applications/Firefox.app/Contents/MacOS/firefox -profile /tmp/roxybrowser-bidi-sync --remote-debugging-port=7777",
        "702 701 /Applications/Firefox.app/Contents/MacOS/plugin-container child",
        "801 1 /Applications/Firefox.app/Contents/MacOS/firefox -profile /Users/me/default"
      ].join("\n")
    } as ReturnType<typeof spawnSync>);

    const { cleanupLocalTestBrowserProcessesSync } = await import(
      "../helpers/browser-process-cleanup.js"
    );
    cleanupLocalTestBrowserProcessesSync();

    expect(killSpy).toHaveBeenCalledWith(701, "SIGTERM");
    expect(killSpy).toHaveBeenCalledWith(-701, "SIGTERM");
    expect(killSpy).toHaveBeenCalledWith(702, "SIGTERM");
    expect(killSpy).toHaveBeenCalledWith(701, "SIGKILL");
    expect(killSpy).toHaveBeenCalledWith(-701, "SIGKILL");
    expect(killSpy).toHaveBeenCalledWith(702, "SIGKILL");
    expect(killSpy).not.toHaveBeenCalledWith(801, expect.anything());
  });

  it("exposes the matched local test browser roots for group cleanup", async () => {
    const { collectLocalTestBrowserProcessTree } = await import(
      "../helpers/browser-process-cleanup.js"
    );

    expect(
      collectLocalTestBrowserProcessTree(
        [
          "101 1 /Applications/Firefox.app/Contents/MacOS/firefox -profile /var/folders/roxybrowser-bidi-a --remote-debugging-port=1234",
          "102 101 /Applications/Firefox.app/Contents/MacOS/plugin-container child",
          "103 102 /Applications/Firefox.app/Contents/MacOS/plugin-container grandchild",
          "201 1 /Applications/Firefox.app/Contents/MacOS/firefox -profile /Users/me/default"
        ].join("\n"),
        999
      )
    ).toEqual({
      rootPids: [101],
      pids: [101, 102, 103]
    });
  });

  it("installs local test browser cleanup hooks once", async () => {
    const onceSpy = vi.spyOn(process, "once").mockImplementation(() => process);
    const state = globalThis as typeof globalThis & {
      __roxyBrowserProcessCleanupHooksInstalled?: boolean;
    };
    delete state.__roxyBrowserProcessCleanupHooksInstalled;

    const { installLocalTestBrowserProcessCleanupHooks } = await import(
      "../helpers/browser-process-cleanup.js"
    );
    installLocalTestBrowserProcessCleanupHooks();
    installLocalTestBrowserProcessCleanupHooks();

    expect(onceSpy).toHaveBeenCalledTimes(5);
    expect(onceSpy).toHaveBeenCalledWith("exit", expect.any(Function));
    expect(onceSpy).toHaveBeenCalledWith("SIGINT", expect.any(Function));
    expect(onceSpy).toHaveBeenCalledWith("SIGTERM", expect.any(Function));
    expect(onceSpy).toHaveBeenCalledWith("uncaughtException", expect.any(Function));
    expect(onceSpy).toHaveBeenCalledWith("unhandledRejection", expect.any(Function));

    onceSpy.mockRestore();
    delete state.__roxyBrowserProcessCleanupHooksInstalled;
  });

  it("terminates a spawned browser process group and discovered children", async () => {
    vi.mocked(execFile).mockImplementation((_file, _args, callback) => {
      callback(
        null,
        [
          "501 1",
          "502 501",
          "503 502"
        ].join("\n")
      );
      return undefined as never;
    });

    const proc = new EventEmitter() as EventEmitter & {
      pid: number;
      kill: ReturnType<typeof vi.fn>;
    };
    proc.pid = 501;
    proc.kill = vi.fn(() => true);

    const { terminateProcessTree } = await import("../../src/processCleanup.js");
    const cleanup = terminateProcessTree(proc, { timeoutMs: 500 });

    await vi.advanceTimersByTimeAsync(500);
    await cleanup;

    expect(killSpy).toHaveBeenCalledWith(-501, "SIGTERM");
    expect(killSpy).toHaveBeenCalledWith(503, "SIGKILL");
    expect(killSpy).toHaveBeenCalledWith(502, "SIGKILL");
    expect(killSpy).toHaveBeenCalledWith(501, "SIGKILL");
    expect(proc.kill).not.toHaveBeenCalled();
  });

  it("falls back to synchronous cleanup when async cleanup times out", async () => {
    vi.mocked(execFile).mockImplementation(() => undefined as never);
    vi.mocked(spawnSync).mockReturnValue({
      stdout: [
        "901 1 /Applications/Firefox.app/Contents/MacOS/firefox -profile /tmp/roxybrowser-bidi-timeout --remote-debugging-port=7777",
        "902 901 /Applications/Firefox.app/Contents/MacOS/plugin-container child"
      ].join("\n")
    } as ReturnType<typeof spawnSync>);

    const { cleanupLocalTestBrowserProcessesWithTimeout } = await import(
      "../helpers/browser-process-cleanup.js"
    );
    const cleanup = cleanupLocalTestBrowserProcessesWithTimeout();

    await vi.advanceTimersByTimeAsync(5_000);
    await cleanup;

    expect(killSpy).toHaveBeenCalledWith(901, "SIGTERM");
    expect(killSpy).toHaveBeenCalledWith(-901, "SIGTERM");
    expect(killSpy).toHaveBeenCalledWith(902, "SIGTERM");
    expect(killSpy).toHaveBeenCalledWith(901, "SIGKILL");
    expect(killSpy).toHaveBeenCalledWith(-901, "SIGKILL");
    expect(killSpy).toHaveBeenCalledWith(902, "SIGKILL");
  });
});
