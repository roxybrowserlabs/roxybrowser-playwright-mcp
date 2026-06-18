import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoxyAPIRequestContext } from "./apiRequestContext.js";
import { RoxyBrowserContextClockDelegate } from "./browserContextClock.js";
import { RoxyClock } from "./clock.js";
import { normalizeExtraHTTPHeaders } from "./httpHeaders.js";
import { RoxyPage } from "./page.js";
import { RoxyVideo } from "./video.js";
import type { ResolvedHumanizationOptions } from "./human/types.js";
import type {
  ProtocolBrowserContextAdapter,
  ProtocolPageAdapter
} from "./protocol/adapter.js";
import type { BrowserContext, Clock, Page } from "./types/api.js";
import type { BrowserContextOptions, RecordVideoOptions } from "./types/options.js";

export class RoxyBrowserContext implements BrowserContext {
  private readonly pageSet = new Set<RoxyPage>();
  private readonly pageByAdapter = new Map<ProtocolPageAdapter, RoxyPage>();
  private readonly adapterByPage = new WeakMap<RoxyPage, ProtocolPageAdapter>();
  private readonly pendingPageRegistrations = new Map<ProtocolPageAdapter, Promise<RoxyPage>>();
  private readonly clockDelegate = new RoxyBrowserContextClockDelegate();
  private readonly disposeAdapterPageListener: (() => void) | null;
  private videoOutputDirPromise: Promise<string> | null = null;
  readonly clock: Clock = new RoxyClock(this.clockDelegate);
  readonly request = new RoxyAPIRequestContext();

  constructor(
    private readonly adapter: ProtocolBrowserContextAdapter,
    private readonly humanDefaults: ResolvedHumanizationOptions,
    private readonly options: BrowserContextOptions = {}
  ) {
    this.disposeAdapterPageListener =
      this.adapter.onPage?.((pageAdapter, openerAdapter, hasWindowOpener) => {
        void this.attachDiscoveredPage(
          pageAdapter,
          openerAdapter ?? null,
          hasWindowOpener ?? true
        );
      }) ?? null;
  }

  async newPage(): Promise<Page> {
    const pageAdapter = await this.adapter.newPage();
    return this.registerPage(pageAdapter);
  }

  pages(): Page[] {
    return Array.from(this.pageSet);
  }

  async close(): Promise<void> {
    try {
      this.disposeAdapterPageListener?.();
      await Promise.all(
        Array.from(this.pageSet).map(async (page) => {
          await page.close();
        })
      );
    } finally {
      await this.request.dispose();
      await this.adapter.close();
    }
  }

  async setExtraHTTPHeaders(headers: { [key: string]: string }): Promise<void> {
    await this.adapter.setExtraHTTPHeaders(normalizeExtraHTTPHeaders(headers));
  }

  async storageState(options?: {
    indexedDB?: boolean;
    path?: string;
  }): Promise<{
    cookies: Array<{
      name: string;
      value: string;
      domain: string;
      path: string;
      expires: number;
      httpOnly: boolean;
      secure: boolean;
      sameSite: "Strict" | "Lax" | "None";
    }>;
    origins: Array<{
      origin: string;
      localStorage: Array<{
        name: string;
        value: string;
      }>;
    }>;
  }> {
    return this.request.storageState(options);
  }

  detachPage(page: RoxyPage): void {
    this.pageSet.delete(page);
    const adapter = this.adapterByPage.get(page);
    if (adapter) {
      this.pageByAdapter.delete(adapter);
      this.pendingPageRegistrations.delete(adapter);
      this.adapterByPage.delete(page);
    }
    this.clockDelegate.detachPage(page);
  }

  private async attachDiscoveredPage(
    pageAdapter: ProtocolPageAdapter,
    openerAdapter: ProtocolPageAdapter | null,
    hasWindowOpener: boolean
  ): Promise<void> {
    const page = await this.registerPage(pageAdapter);
    if (!openerAdapter) {
      return;
    }

    const opener = await this.registerPage(openerAdapter);
    if (opener === page) {
      return;
    }

    page.setOpener(hasWindowOpener ? opener : null);
    opener.emitPopup(page);
  }

  private async registerPage(pageAdapter: ProtocolPageAdapter): Promise<RoxyPage> {
    const pending = this.pendingPageRegistrations.get(pageAdapter);
    if (pending) {
      return pending;
    }

    const existing = this.pageByAdapter.get(pageAdapter);
    if (existing) {
      return existing;
    }

    const registration = this.createPage(pageAdapter);
    this.pendingPageRegistrations.set(pageAdapter, registration);
    try {
      return await registration;
    } finally {
      this.pendingPageRegistrations.delete(pageAdapter);
    }
  }

  private async createPage(pageAdapter: ProtocolPageAdapter): Promise<RoxyPage> {
    const page = new RoxyPage(pageAdapter, this.humanDefaults, this);
    this.pageSet.add(page);
    this.pageByAdapter.set(pageAdapter, page);
    this.adapterByPage.set(page, pageAdapter);

    try {
      await this.clockDelegate.attachPage(page);
      if (this.options.recordVideo) {
        await this.enableRecordVideo(page, this.options.recordVideo);
      }
      return page;
    } catch (error) {
      this.pageSet.delete(page);
      this.pageByAdapter.delete(pageAdapter);
      this.adapterByPage.delete(page);
      this.clockDelegate.detachPage(page);
      throw error;
    }
  }

  private async enableRecordVideo(page: RoxyPage, options: RecordVideoOptions): Promise<void> {
    const directory = await this.resolveVideoOutputDirectory(options.dir);
    const videoPath = join(directory, `${randomUUID()}.webm`);
    const videoSize = options.size ?? this.deriveDefaultRecordVideoSize();
    let resolveFinished!: () => void;
    let rejectFinished!: (error: unknown) => void;
    const finished = new Promise<void>((resolve, reject) => {
      resolveFinished = resolve;
      rejectFinished = reject;
    });
    const video = new RoxyVideo(videoPath, finished);
    page.setVideo(video);

    try {
      const recording = await page.startVideoRecording({
        path: videoPath,
        size: videoSize,
        ...(options.showActions ? { showActions: options.showActions } : {})
      });

      page.setVideo(video, async () => {
        try {
          await recording.dispose();
          resolveFinished();
        } catch (error) {
          rejectFinished(error);
          throw error;
        }
      }, rejectFinished);
    } catch (error) {
      page.setVideo(null);
      rejectFinished(error);
      throw error;
    }
  }

  private async resolveVideoOutputDirectory(configuredDirectory?: string): Promise<string> {
    if (configuredDirectory) {
      return configuredDirectory;
    }
    if (!this.videoOutputDirPromise) {
      this.videoOutputDirPromise = mkdtemp(join(tmpdir(), "roxy-videos-"));
    }
    return this.videoOutputDirPromise;
  }

  private deriveDefaultRecordVideoSize(): { width: number; height: number } {
    if (Object.prototype.hasOwnProperty.call(this.options, "viewport") && this.options.viewport === null) {
      return {
        width: 800,
        height: 600
      };
    }

    if (this.options.viewport) {
      const scale = Math.min(1, 800 / Math.max(this.options.viewport.width, this.options.viewport.height));
      return {
        width: Math.max(2, Math.floor(this.options.viewport.width * scale)) & ~1,
        height: Math.max(2, Math.floor(this.options.viewport.height * scale)) & ~1
      };
    }

    return {
      width: 800,
      height: 450
    };
  }
}
