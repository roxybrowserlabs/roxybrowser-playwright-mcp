import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { RoxyAPIRequestContext } from "../../src/apiRequestContext.js";
import { RoxyBrowserContext } from "../../src/browserContext.js";
import {
  createBrowserContextAdapterStub,
  createPageAdapterStub
} from "../helpers/fakes.js";

function readZipEntries(buffer: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  let offset = 0;
  while (offset < buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const compression = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const uncompressedSize = buffer.readUInt32LE(offset + 22);
    const fileNameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + fileNameLength + extraLength;
    const name = buffer.subarray(nameStart, nameStart + fileNameLength).toString("utf8");
    if (compression !== 0) {
      throw new Error(`Unsupported test zip compression for ${name}`);
    }
    entries.set(name, buffer.subarray(dataStart, dataStart + uncompressedSize));
    offset = dataStart + compressedSize;
  }
  return entries;
}

function parseJsonLines(buffer: Buffer): unknown[] {
  return buffer
    .toString("utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);
}

describe("RoxyTracing", () => {
  it("keeps Playwright tracing pipeline components as first-class modules", async () => {
    const root = resolve(import.meta.dirname, "../..");
    const files = await Promise.all([
      readFile(join(root, "src/tracing/localUtils.ts"), "utf8"),
      readFile(join(root, "src/tracing/snapshotter.ts"), "utf8"),
      readFile(join(root, "src/tracing/harTracer.ts"), "utf8"),
      readFile(join(root, "src/tracing/harRecorder.ts"), "utf8"),
      readFile(join(root, "src/tracing/channel.ts"), "utf8")
    ]);

    expect(files[0]).toContain("class LocalUtils");
    expect(files[0]).toContain("tracingStarted");
    expect(files[0]).toContain("addStackToTracingNoReply");
    expect(files[1]).toContain("class Snapshotter");
    expect(files[1]).toContain("captureSnapshot");
    expect(files[2]).toContain("class HarTracer");
    expect(files[3]).toContain("class HarRecorder");
    expect(files[4]).toContain("tracingStartChunk");
    expect(files[4]).toContain("tracingStopChunk");
  });

  it("records APIRequestContext HAR and trace archives like Playwright tracing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "roxy-tracing-api-"));
    const harPath = join(directory, "request.har");
    const tracePath = join(directory, "trace.zip");
    const request = new RoxyAPIRequestContext();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response('{"ok":true}', {
        headers: {
          "content-type": "application/json"
        },
        status: 200,
        statusText: "OK"
      })
    );

    try {
      await request.tracing.start({ name: "api-trace", title: "API trace", snapshots: true });
      await request.tracing.startHar(harPath, { mode: "minimal", urlFilter: /\/data$/ });
      await request.get("https://example.com/data");
      await request.get("https://example.com/ignored");
      await request.tracing.stopHar();
      await request.tracing.stop({ path: tracePath });

      const har = JSON.parse(await readFile(harPath, "utf8"));
      expect(har.log.entries.map((entry: any) => entry.request.url)).toEqual([
        "https://example.com/data"
      ]);
      expect(har.log.entries[0].request.bodySize).toBe(-1);

      const traceEntries = readZipEntries(await readFile(tracePath));
      expect(traceEntries.has("trace.trace")).toBe(true);
      expect(traceEntries.has("trace.network")).toBe(true);
      expect(traceEntries.has("trace.stacks")).toBe(true);
      const traceEvents = parseJsonLines(traceEntries.get("trace.trace")!);
      expect(traceEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "context-options", version: 8, origin: "library" }),
          expect.objectContaining({
            type: "before",
            class: "APIRequestContext",
            method: "get"
          }),
          expect.objectContaining({
            type: "after"
          })
        ])
      );
      expect(traceEvents).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ owner: expect.any(String) }),
          expect.objectContaining({ groupDepth: expect.any(Number) })
        ])
      );
      const networkEvents = parseJsonLines(traceEntries.get("trace.network")!);
      expect(networkEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "resource-snapshot",
            snapshot: expect.objectContaining({
              request: expect.objectContaining({ url: "https://example.com/data" }),
              response: expect.objectContaining({ status: 200 })
            })
          })
        ])
      );
    } finally {
      fetchSpy.mockRestore();
      await request.dispose();
    }
  });

  it("exports pending HAR on dispose and rejects invalid tracing state transitions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "roxy-tracing-dispose-"));
    const harPath = join(directory, "request.har.zip");
    const request = new RoxyAPIRequestContext();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("ok", {
        headers: {
          "content-type": "text/plain"
        },
        status: 200,
        statusText: "OK"
      })
    );

    try {
      await expect(request.tracing.stopHar()).rejects.toThrow("HAR recording has not been started");
      await expect(
        request.tracing.startHar(harPath, { resourcesDir: join(directory, "resources") })
      ).rejects.toThrow("resourcesDir option is not compatible with a .zip har file");

      await request.tracing.startHar(harPath, { content: "attach" });
      await expect(request.tracing.startHar(join(directory, "again.har"))).rejects.toThrow(
        "HAR recording has already been started"
      );
      await request.get("https://example.com/dispose");
      await request.dispose();

      const entries = readZipEntries(await readFile(harPath));
      expect(entries.has("har.har")).toBe(true);
      const har = JSON.parse(entries.get("har.har")!.toString("utf8"));
      expect(har.log.entries[0].request.url).toBe("https://example.com/dispose");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("records BrowserContext page network events into HAR and trace output", async () => {
    const directory = await mkdtemp(join(tmpdir(), "roxy-tracing-context-"));
    const harPath = join(directory, "context.har");
    const tracePath = join(directory, "context-trace.zip");
    const adapter = createBrowserContextAdapterStub();
    const pageAdapter = createPageAdapterStub();
    adapter.newPage = async () => pageAdapter;
    const context = new RoxyBrowserContext(adapter, {
      enabled: true,
      profile: "balanced",
      moveJitterMs: 16,
      clickHoldMs: 60,
      scrollStepPx: 280,
      typingDelayMs: 95,
      typingVarianceMs: 35,
      hoverBeforeClickMs: 110
    });
    await context.tracing.start({ name: "context-trace" });
    await context.tracing.startHar(harPath);
    await context.newPage();

    pageAdapter.emit("request", {
      headers: [{ name: "accept", value: "text/html" }],
      method: "GET",
      requestId: "request-1",
      resourceType: "document",
      url: "https://example.com/page"
    });
    pageAdapter.emit("response", {
      body: async () => Buffer.from("<html></html>"),
      frameId: "frame-1",
      fromCache: false,
      headers: [{ name: "content-type", value: "text/html" }],
      mimeType: "text/html",
      requestId: "request-1",
      resourceType: "document",
      status: 200,
      statusText: "OK",
      text: async () => "<html></html>",
      url: "https://example.com/page"
    });
    pageAdapter.emit("requestfinished", {
      headers: [{ name: "accept", value: "text/html" }],
      method: "GET",
      requestId: "request-1",
      resourceType: "document",
      url: "https://example.com/page"
    });

    await context.tracing.stopHar();
    await context.tracing.stop({ path: tracePath });
    await context.close();

    const har = JSON.parse(await readFile(harPath, "utf8"));
    expect(har.log.pages).toHaveLength(1);
    expect(har.log.entries[0].request.url).toBe("https://example.com/page");
    expect(har.log.entries[0].response.status).toBe(200);

    const traceEntries = readZipEntries(await readFile(tracePath));
    const networkEvents = parseJsonLines(traceEntries.get("trace.network")!);
    expect(networkEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          snapshot: expect.objectContaining({
            request: expect.objectContaining({ url: "https://example.com/page" })
          })
        })
      ])
    );
  });
});
