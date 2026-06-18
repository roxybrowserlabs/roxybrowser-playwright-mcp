import type { ProtocolPageAdapter } from "./protocol/adapter.js";
import type { ScreencastFrame } from "./types/events.js";
import type { Disposable, Screencast as ScreencastApi } from "./types/api.js";
import { ScreencastFrameRecorder } from "./video.js";

class DisposableStub implements Disposable {
  private disposeCallback: (() => Promise<void>) | undefined;

  constructor(dispose: () => Promise<void>) {
    this.disposeCallback = dispose;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.dispose();
  }

  async dispose(): Promise<void> {
    if (!this.disposeCallback) {
      return;
    }

    const dispose = this.disposeCallback;
    this.disposeCallback = undefined;
    await dispose();
  }
}

export class RoxyScreencast implements ScreencastApi {
  private started = false;
  private onFrame: ((frame: ScreencastFrame) => Promise<any> | any) | null = null;
  private manualRecorder: ScreencastFrameRecorder | null = null;
  private readonly activeRecorders = new Set<ScreencastFrameRecorder>();

  constructor(private readonly adapter: ProtocolPageAdapter) {
    this.adapter.on("screencastFrame", (frame) => {
      for (const recorder of this.activeRecorders) {
        recorder.writeFrame(frame.data, frame.timestamp);
      }
      void this.onFrame?.(frame);
    });
  }

  async start(options: {
    onFrame?: (frame: ScreencastFrame) => Promise<any> | any;
    path?: string;
    size?: {
      width: number;
      height: number;
    };
    quality?: number;
    annotate?: {
      duration?: number;
      position?: "top-left" | "top" | "top-right" | "bottom-left" | "bottom" | "bottom-right";
      fontSize?: number;
    };
  } = {}): Promise<Disposable> {
    if (this.started) {
      throw new Error("Screencast is already started");
    }

    this.started = true;
    this.onFrame = options.onFrame ?? null;
    const recorder = options.path ? this.createRecorder(options.path, options.size, options.quality) : null;
    this.manualRecorder = recorder;
    try {
      await recorder?.ready();
      await this.adapter.screencastStart({
        sendFrames: Boolean(options.onFrame || recorder),
        ...(options.size ? { size: options.size } : {}),
        ...(options.quality !== undefined ? { quality: options.quality } : {}),
        ...(options.annotate ? { annotate: options.annotate } : {})
      });
      if (recorder) {
        this.activeRecorders.add(recorder);
      }
    } catch (error) {
      this.started = false;
      this.onFrame = null;
      this.manualRecorder = null;
      throw error;
    }

    return new DisposableStub(() => this.stop());
  }

  async startBackgroundRecording(options: {
    path: string;
    size?: {
      width: number;
      height: number;
    };
    quality?: number;
    showActions?: {
      duration?: number;
      position?: "top-left" | "top" | "top-right" | "bottom-left" | "bottom" | "bottom-right";
      fontSize?: number;
    };
  }): Promise<Disposable> {
    const recorder = this.createRecorder(options.path, options.size, options.quality);
    await recorder.ready();
    await this.adapter.screencastStart({
      sendFrames: true,
      ...(options.size ? { size: options.size } : {}),
      ...(options.quality !== undefined ? { quality: options.quality } : {})
    });
    this.activeRecorders.add(recorder);

    const actions = options.showActions
      ? await this.showActions(options.showActions)
      : null;

    return new DisposableStub(async () => {
      this.activeRecorders.delete(recorder);
      try {
        if (actions) {
          await actions.dispose();
        }
        await this.adapter.screencastStop();
      } finally {
        await recorder.stop();
      }
    });
  }

  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }

    const recorder = this.manualRecorder;
    this.started = false;
    this.onFrame = null;
    this.manualRecorder = null;
    if (recorder) {
      this.activeRecorders.delete(recorder);
    }

    try {
      await this.adapter.screencastStop();
    } finally {
      await recorder?.stop();
    }
  }

  async showActions(options?: {
    duration?: number;
    position?: "top-left" | "top" | "top-right" | "bottom-left" | "bottom" | "bottom-right";
    fontSize?: number;
    cursor?: "none" | "pointer";
  }): Promise<Disposable> {
    await this.adapter.screencastShowActions(options);
    return new DisposableStub(() => this.adapter.screencastHideActions());
  }

  async hideActions(): Promise<void> {
    await this.adapter.screencastHideActions();
  }

  async showOverlay(
    html: string,
    options?: {
      duration?: number;
    }
  ): Promise<Disposable> {
    const result = await this.adapter.screencastShowOverlay({
      html,
      ...(options?.duration !== undefined ? { duration: options.duration } : {})
    });
    return new DisposableStub(() => this.adapter.screencastRemoveOverlay(result.id));
  }

  async showChapter(
    title: string,
    options?: {
      description?: string;
      duration?: number;
    }
  ): Promise<void> {
    await this.adapter.screencastChapter({
      title,
      ...(options?.description !== undefined ? { description: options.description } : {}),
      ...(options?.duration !== undefined ? { duration: options.duration } : {})
    });
  }

  async showOverlays(): Promise<void> {
    await this.adapter.screencastSetOverlayVisible(true);
  }

  async hideOverlays(): Promise<void> {
    await this.adapter.screencastSetOverlayVisible(false);
  }

  private createRecorder(
    path: string,
    size?: {
      width: number;
      height: number;
    },
    quality?: number
  ): ScreencastFrameRecorder {
    const recordingSize = size ?? deriveDefaultVideoSize(this.adapter.viewportSize());
    return new ScreencastFrameRecorder({
      path,
      size: recordingSize,
      captureFallbackFrame: async () =>
        this.adapter.screenshot({
          type: "jpeg",
          ...(quality !== undefined ? { quality } : {})
        })
    });
  }
}

function deriveDefaultVideoSize(
  viewport: { width: number; height: number } | null
): { width: number; height: number } {
  const resolvedViewport = viewport ?? {
    width: 800,
    height: 600
  };
  const scale = Math.min(1, 800 / Math.max(resolvedViewport.width, resolvedViewport.height));
  return {
    width: Math.max(2, Math.floor(resolvedViewport.width * scale)) & ~1,
    height: Math.max(2, Math.floor(resolvedViewport.height * scale)) & ~1
  };
}
