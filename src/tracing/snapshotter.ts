import type { BrowserContext, Page } from "../types/api.js";

export type SnapshotterBlob = {
  buffer: Buffer;
  sha1: string;
};

export interface SnapshotterDelegate {
  onSnapshotterBlob(blob: SnapshotterBlob): void;
  onFrameSnapshot(snapshot: Record<string, unknown>): void;
}

export class Snapshotter {
  private startedState = false;

  constructor(
    private readonly context: BrowserContext | null,
    private readonly delegate: SnapshotterDelegate
  ) {}

  started(): boolean {
    return this.startedState;
  }

  async start(): Promise<void> {
    this.startedState = true;
    await this.context?.addInitScript(() => {
      (globalThis as typeof globalThis & { __playwright_snapshot_streamer_installed__?: boolean })
        .__playwright_snapshot_streamer_installed__ = true;
    }).catch(() => undefined);
  }

  stop(): void {
    this.startedState = false;
  }

  async reset(): Promise<void> {}

  async resetForReuse(): Promise<void> {
    this.stop();
  }

  dispose(): void {
    this.stop();
  }

  async captureSnapshot(page: Page, callId: string, snapshotName: string, resetTargets: boolean): Promise<void> {
    void resetTargets;
    if (!this.startedState) {
      return;
    }
    this.delegate.onFrameSnapshot({
      callId,
      snapshotName,
      pageId: page.url(),
      frameId: "main",
      frameUrl: page.url(),
      html: [],
      viewport: undefined,
      timestamp: Date.now(),
      wallTime: Date.now(),
      collectionTime: 0,
      resourceOverrides: [],
      isMainFrame: true
    });
  }
}
