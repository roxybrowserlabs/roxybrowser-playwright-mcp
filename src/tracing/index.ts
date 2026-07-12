import { LocalUtils } from "./localUtils.js";
import { PlaywrightTracingChannel } from "./channel.js";
import type { BrowserContext, Disposable, Page, Tracing } from "../types/api.js";
import type { APIRequestTraceRecord, BrowserContextLike, HarOptions, TraceOptions } from "./types.js";

class DisposableStub implements Disposable {
  constructor(private readonly callback: () => Promise<void> | void) {}

  async dispose(): Promise<void> {
    await this.callback();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.dispose();
  }
}

export class RoxyTracing implements Tracing {
  private readonly channel: PlaywrightTracingChannel;
  private readonly localUtils = new LocalUtils();
  private includeSources = false;
  private isLive = false;
  private isTracing = false;
  private stacksId: string | undefined;

  constructor(
    ownerName: "apiRequestContext" | "browserContext",
    context: BrowserContextLike | null = null
  ) {
    this.channel = new PlaywrightTracingChannel(ownerName, context);
    if (context) {
      this.channel.attachContext(context);
    }
  }

  async start(options: TraceOptions = {}): Promise<void> {
    this.includeSources = !!options.sources;
    this.isLive = !!options.live;
    await this.channel.tracingStart(options);
    const { traceName } = await this.channel.tracingStartChunk({
      ...(options.name !== undefined ? { name: options.name } : {}),
      ...(options.title !== undefined ? { title: options.title } : {})
    });
    await this.startCollectingStacks(traceName, this.isLive);
  }

  async startChunk(options: { name?: string; title?: string } = {}): Promise<void> {
    const { traceName } = await this.channel.tracingStartChunk(options);
    await this.startCollectingStacks(traceName, this.isLive);
  }

  async stop(options: { path?: string } = {}): Promise<void> {
    await this.doStopChunk(options.path);
    await this.channel.tracingStop();
  }

  async stopChunk(options: { path?: string } = {}): Promise<void> {
    await this.doStopChunk(options.path);
  }

  async group(name: string, options: { location?: { file: string; line?: number; column?: number } } = {}): Promise<Disposable> {
    if (options.location) {
      this.localUtils.addStackToTracingNoReply({
        callData: { id: `group:${name}`, stack: [options.location] }
      });
    }
    this.channel.tracingGroup({ name, ...(options.location ? { location: options.location } : {}) });
    return new DisposableStub(() => this.groupEnd());
  }

  async groupEnd(): Promise<void> {
    this.channel.tracingGroupEnd();
  }

  async startHar(path: string, options: HarOptions = {}): Promise<Disposable> {
    this.channel.harStart(path, options);
    return new DisposableStub(() => this.stopHar());
  }

  async stopHar(): Promise<void> {
    await this.channel.harExport();
  }

  async exportAllHars(): Promise<void> {
    await this.channel.exportAllHars();
  }

  attachContext(context: BrowserContext): void {
    this.channel.attachContext(context);
  }

  attachPage(page: Page): void {
    this.channel.attachPage(page);
  }

  detachPage(page: Page): void {
    this.channel.detachPage(page);
  }

  async recordApiRequest(record: APIRequestTraceRecord): Promise<void> {
    this.localUtils.addStackToTracingNoReply({
      callData: {
        id: `${record.apiName}:${record.startedAt}`
      }
    });
    await this.channel.recordApiRequest(record);
  }

  private async startCollectingStacks(traceName: string, live: boolean): Promise<void> {
    if (!this.isTracing) {
      this.isTracing = true;
    }
    const result = await this.localUtils.tracingStarted({ traceName, live });
    this.stacksId = result.stacksId;
  }

  private async doStopChunk(filePath: string | undefined): Promise<void> {
    this.resetStackCounter();
    if (!filePath) {
      await this.channel.tracingStopChunk({ mode: "discard" });
      await this.localUtils.traceDiscarded({ ...(this.stacksId !== undefined ? { stacksId: this.stacksId } : {}) });
      return;
    }
    const result = await this.channel.tracingStopChunk({ mode: "entries" });
    await this.localUtils.zip({
      zipFile: filePath,
      entries: result.entries ?? [],
      mode: "write",
      ...(this.stacksId !== undefined ? { stacksId: this.stacksId } : {}),
      includeSources: this.includeSources,
      additionalSources: []
    });
  }

  private resetStackCounter(): void {
    if (this.isTracing) {
      this.isTracing = false;
    }
  }
}
