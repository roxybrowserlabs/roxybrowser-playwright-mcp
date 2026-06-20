import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import {
  readDevToolsActivePort,
  waitForDebuggerEndpoint
} from "../../src/protocol/cdp/backend.js";

function createProcessStub(): EventEmitter & {
  stderr: EventEmitter;
  stdout: EventEmitter;
} {
  const processRef = new EventEmitter() as EventEmitter & {
    stderr: EventEmitter;
    stdout: EventEmitter;
  };
  processRef.stderr = new EventEmitter();
  processRef.stdout = new EventEmitter();
  return processRef;
}

describe("CDP launch helpers", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads a websocket endpoint from DevToolsActivePort", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "roxy-cdp-launch-test-"));
    tempDirs.push(userDataDir);

    writeFileSync(join(userDataDir, "DevToolsActivePort"), "9222\n/devtools/browser/test-id\n");

    await expect(
      readDevToolsActivePort(join(userDataDir, "DevToolsActivePort"))
    ).resolves.toBe("ws://127.0.0.1:9222/devtools/browser");
  });

  it("falls back to DevToolsActivePort when Chromium does not print the endpoint", async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "roxy-cdp-launch-test-"));
    tempDirs.push(userDataDir);
    const processRef = createProcessStub();

    const endpointPromise = waitForDebuggerEndpoint(processRef, userDataDir, 1_000);

    setTimeout(() => {
      writeFileSync(join(userDataDir, "DevToolsActivePort"), "9333\n/devtools/browser/abc\n");
    }, 50);

    await expect(endpointPromise).resolves.toBe("ws://127.0.0.1:9333/devtools/browser");
  });
});
