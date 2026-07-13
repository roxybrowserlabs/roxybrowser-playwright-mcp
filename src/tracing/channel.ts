import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { HarTracer } from "./harTracer.js";
import { Snapshotter } from "./snapshotter.js";
import type {
  APIRequestTraceRecord,
  BrowserContextLike,
  HarOptions,
  NetworkRecord,
  PendingPageRequest,
  TraceChunk,
  TraceEntry,
  TraceOptions,
  TraceablePage
} from "./types.js";
import type { BrowserContext, Page, Request, Response } from "../types/api.js";

export class PlaywrightTracingChannel {
  private readonly harTracer = new HarTracer();
  private readonly pageDisposers = new Map<Page, Array<() => void>>();
  private readonly pageIds = new WeakMap<Page, string>();
  private readonly pendingOperations = new Set<Promise<void>>();
  private readonly pendingPageRequests = new WeakMap<Request, PendingPageRequest>();
  private readonly snapshotter: Snapshotter;
  private chunk: TraceChunk | null = null;
  private groupStack: string[] = [];
  private nextCallId = 0;
  private nextPageId = 0;
  private traceName: string | null = null;
  private harRecording = false;
  private tracingOptions: TraceOptions = {};

  constructor(
    private readonly ownerName: "apiRequestContext" | "browserContext",
    private readonly context: BrowserContextLike | null = null
  ) {
    this.snapshotter = new Snapshotter(context, {
      onSnapshotterBlob: () => {},
      onFrameSnapshot: (snapshot) => this.appendTraceEvent({ type: "frame-snapshot", snapshot })
    });
  }

  async tracingStart(options: TraceOptions = {}): Promise<void> {
    if (this.traceName) {
      throw new Error("Tracing has been already started");
    }
    this.traceName = options.name ?? `trace-${Date.now()}`;
    this.tracingOptions = { ...options };
    this.syncNetworkCollection();
    if (options.snapshots) {
      await this.snapshotter.start();
    }
  }

  async tracingStartChunk(options: { name?: string; title?: string } = {}): Promise<{ traceName: string }> {
    if (!this.traceName) {
      throw new Error("Must start tracing before starting a new chunk");
    }
    if (this.chunk) {
      await this.tracingStopChunk({ mode: "discard" });
    }
    const name = options.name ?? this.traceName;
    const tracesDir = await mkdtemp(join(tmpdir(), "playwright-tracing-"));
    const traceFile = join(tracesDir, `${name}.trace`);
    const networkFile = join(tracesDir, `${name}.network`);
    this.chunk = {
      events: [],
      name,
      networkFile,
      options: { ...this.tracingOptions, ...options },
      traceFile,
      tracesDir
    };
    await mkdir(dirname(traceFile), { recursive: true });
    await writeFile(networkFile, "");
    this.appendTraceEvent({
      version: 8,
      type: "context-options",
      origin: "library",
      browserName: "roxybrowser",
      playwrightVersion: "1.61.1",
      options: {},
      platform: process.platform,
      wallTime: Date.now(),
      monotonicTime: Date.now(),
      sdkLanguage: "javascript",
      title: options.title,
      contextId: this.ownerName
    });
    return { traceName: name };
  }

  async tracingStopChunk(params: { mode: "discard" | "entries" | "archive" }): Promise<{ entries?: TraceEntry[] }> {
    await this.drainPendingOperations();
    const chunk = this.chunk;
    this.chunk = null;
    if (!chunk) {
      if (params.mode !== "discard") {
        throw new Error("Must start tracing before stopping");
      }
      return {};
    }
    await writeFile(chunk.traceFile, toJsonLines(chunk.events));
    if (params.mode === "discard") {
      return {};
    }
    return {
      entries: [
        { name: "trace.trace", value: chunk.traceFile },
        { name: "trace.network", value: chunk.networkFile }
      ]
    };
  }

  async tracingStop(): Promise<void> {
    this.snapshotter.stop();
    this.traceName = null;
    this.syncNetworkCollection();
  }

  tracingGroup(params: { name: string; location?: { file: string; line?: number; column?: number } }): void {
    const callId = this.callId();
    this.groupStack.push(callId);
    this.appendTraceEvent({
      type: "before",
      callId,
      startTime: Date.now(),
      title: params.name,
      class: "Tracing",
      method: "tracingGroup",
      params: {},
      stack: params.location ? [params.location] : []
    });
  }

  tracingGroupEnd(): void {
    const callId = this.groupStack.pop();
    if (!callId) {
      return;
    }
    this.appendTraceEvent({
      type: "after",
      callId,
      endTime: Date.now()
    });
  }

  harStart(path: string, options: HarOptions = {}): string {
    const result = this.harTracer.start(path, options);
    this.harRecording = true;
    for (const page of this.context?.pages() ?? []) {
      this.harTracer.addPage({ id: this.pageId(page), title: safePageUrl(page) });
    }
    this.syncNetworkCollection();
    return result;
  }

  async harExport(): Promise<void> {
    try {
      await this.drainPendingOperations();
      await this.harTracer.stop();
    } finally {
      this.harRecording = false;
      this.syncNetworkCollection();
    }
  }

  async exportAllHars(): Promise<void> {
    try {
      await this.drainPendingOperations();
      await this.harTracer.exportAll();
    } finally {
      this.harRecording = false;
      this.syncNetworkCollection();
    }
  }

  attachContext(context: BrowserContext): void {
    if (!this.isNetworkCollectionActive()) {
      return;
    }
    for (const page of context.pages()) {
      this.attachPage(page);
    }
  }

  attachPage(page: Page): void {
    if (!this.isNetworkCollectionActive() || this.pageDisposers.has(page)) {
      return;
    }
    const pageId = this.pageId(page);
    this.harTracer.addPage({ id: pageId, title: safePageUrl(page) });
    const traceablePage = page as TraceablePage;
    const disposers = [
      traceablePage.attachInternalListener("request", (request: Request) => {
        this.pendingPageRequests.set(request, { request, startedAt: Date.now() });
      }),
      traceablePage.attachInternalRequestFinishedListener(({ request, response }) =>
        this.track(this.recordPageRequest(request, response, false))
      ),
      traceablePage.attachInternalListener("requestfailed", (request: Request) =>
        this.track(this.recordPageRequest(request, null, true))
      )
    ];
    this.pageDisposers.set(page, disposers);
  }

  detachPage(page: Page): void {
    const disposers = this.pageDisposers.get(page);
    if (!disposers) {
      return;
    }
    for (const dispose of disposers) {
      dispose();
    }
    this.pageDisposers.delete(page);
  }

  async recordApiRequest(record: APIRequestTraceRecord): Promise<void> {
    const callId = this.callId();
    const parsed = parseApiName(record.apiName);
    this.appendTraceEvent({
      type: "before",
      callId,
      startTime: record.startedAt,
      class: parsed.className,
      method: parsed.method,
      params: { url: record.url, method: record.method }
    });
    if (record.response) {
      await this.recordNetwork({
        body: record.responseBody ?? Buffer.alloc(0),
        method: record.method,
        requestHeaders: headerRecordToArray(record.requestHeaders),
        responseHeaders: record.response.headersArray(),
        status: record.response.status(),
        statusText: record.response.statusText(),
        time: Math.max(0, Date.now() - record.startedAt),
        url: record.response.url() || record.url
      });
    }
    this.appendTraceEvent({
      type: "after",
      callId,
      endTime: Date.now(),
      ...(record.error ? { error: { message: record.error.message } } : {})
    });
  }

  private async recordPageRequest(
    request: Request,
    response: Response | null,
    failed: boolean
  ): Promise<void> {
    const pending = this.pendingPageRequests.get(request) ?? { request, startedAt: Date.now() };
    this.pendingPageRequests.delete(request);
    if (!failed && !response) {
      return;
    }
    const body = response ? await response.body().catch(() => Buffer.alloc(0)) : Buffer.alloc(0);
    await this.recordNetwork({
      body,
      method: request.method(),
      requestHeaders: await request.headersArray(),
      responseHeaders: response ? await response.headersArray() : [],
      status: response?.status() ?? -1,
      statusText: response?.statusText() ?? request.failure()?.errorText ?? "",
      time: Math.max(0, Date.now() - pending.startedAt),
      url: request.url()
    });
  }

  private async recordNetwork(record: NetworkRecord): Promise<void> {
    this.harTracer.onEntryFinished(record);
    const chunk = this.chunk;
    if (!chunk) {
      return;
    }
    await writeFile(chunk.networkFile, `${JSON.stringify(toResourceSnapshot(record))}\n`, { flag: "a" });
  }

  private appendTraceEvent(event: Record<string, unknown>): void {
    this.chunk?.events.push(event);
  }

  private callId(): string {
    return `call@${++this.nextCallId}`;
  }

  private pageId(page: Page): string {
    const existing = this.pageIds.get(page);
    if (existing) {
      return existing;
    }
    const created = `page@${++this.nextPageId}`;
    this.pageIds.set(page, created);
    return created;
  }

  private track(operation: Promise<void>): Promise<void> {
    let tracked!: Promise<void>;
    tracked = operation.catch(() => {}).finally(() => {
      this.pendingOperations.delete(tracked);
    });
    this.pendingOperations.add(tracked);
    return tracked;
  }

  private async drainPendingOperations(): Promise<void> {
    while (this.pendingOperations.size > 0) {
      await Promise.all(Array.from(this.pendingOperations));
    }
  }

  private isNetworkCollectionActive(): boolean {
    return this.traceName !== null || this.harRecording;
  }

  private syncNetworkCollection(): void {
    if (this.isNetworkCollectionActive()) {
      for (const page of this.context?.pages() ?? []) {
        this.attachPage(page);
      }
      return;
    }
    for (const page of Array.from(this.pageDisposers.keys())) {
      this.detachPage(page);
    }
  }
}

function toJsonLines(events: Array<Record<string, unknown>>): string {
  return events.map((event) => JSON.stringify(event)).join("\n") + (events.length ? "\n" : "");
}

function headerRecordToArray(headers: Record<string, string>): Array<{ name: string; value: string }> {
  return Object.entries(headers).map(([name, value]) => ({ name, value }));
}

function parseApiName(apiName: string): { className: string; method: string } {
  const [, method = apiName] = apiName.split(".");
  return { className: "APIRequestContext", method };
}

function safePageUrl(page: Page): string {
  try {
    return page.url();
  } catch {
    return "";
  }
}

function toResourceSnapshot(record: NetworkRecord): Record<string, unknown> {
  return {
    type: "resource-snapshot",
    snapshot: {
      _monotonicTime: Date.now() / 1000,
      request: {
        method: record.method,
        url: record.url,
        headers: record.requestHeaders
      },
      response: {
        status: record.status,
        statusText: record.statusText,
        headers: record.responseHeaders,
        content: {
          mimeType: headerValue(record.responseHeaders, "content-type") ?? "application/octet-stream",
          size: record.body.byteLength
        }
      },
      timings: {
        send: 0,
        wait: record.time,
        receive: 0
      }
    }
  };
}

function headerValue(headers: Array<{ name: string; value: string }>, name: string): string | null {
  const lower = name.toLowerCase();
  return headers.find((header) => header.name.toLowerCase() === lower)?.value ?? null;
}
