import { spawn, type ChildProcessByStdio } from "node:child_process";
import { copyFile, mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import type { Readable, Writable } from "node:stream";
import { registerTestBrowserProcessForCleanup } from "./processCleanup.js";
import type { Video } from "./types/api.js";

const VIDEO_RECORDING_FPS = 25;
const FALLBACK_JPEG_1X1_WHITE = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEAAkGBxAQEBUQEA8QFRUVFRUVFRUVFRUVFRUVFRUWFhUVFRUYHSggGBolHRUVITEhJSkrLi4uFx8zODMsNygtLisBCgoKDg0OFQ8PGisdFR0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLf/AABEIAAEAAQMBEQACEQEDEQH/xAAXAAADAQAAAAAAAAAAAAAAAAAAAQMC/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEAMQAAAB6A//xAAVEAEBAAAAAAAAAAAAAAAAAAAAEf/aAAgBAQABBQJf/8QAFBEBAAAAAAAAAAAAAAAAAAAAEP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAEP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAEP/aAAgBAQAGPwJf/8QAFBABAAAAAAAAAAAAAAAAAAAAEP/aAAgBAQABPyF//9k=",
  "base64"
);

function formatMissingFfmpegMessage(): string {
  return [
    "Video rendering requires ffmpeg binary.",
    "Set ROXY_FFMPEG_PATH or install ffmpeg and make it available on PATH."
  ].join(" ");
}

function resolveFfmpegPath(): string {
  return process.env.ROXY_FFMPEG_PATH || "ffmpeg";
}

export class RoxyVideo implements Video {
  constructor(
    private readonly videoPath: string,
    private readonly finished: Promise<void> = Promise.resolve()
  ) {}

  async delete(): Promise<void> {
    await this.finished;
    await rm(this.videoPath, { force: true });
  }

  async path(): Promise<string> {
    return this.videoPath;
  }

  async saveAs(path: string): Promise<void> {
    await this.finished;
    await mkdir(dirname(path), { recursive: true });
    await copyFile(this.videoPath, path);
  }
}

export class ScreencastFrameRecorder {
  private process: ChildProcessByStdio<Writable, null, Readable> | null = null;
  private unregisterProcessCleanup: (() => void) | null = null;
  private stderr = "";
  private stopped = false;
  private firstFrameTimestamp = 0;
  private lastFrame: { buffer: Buffer; timestamp: number; frameNumber: number } | null = null;
  private lastWriteNodeTime = 0;
  private frameQueue: Buffer[] = [];
  private lastWritePromise: Promise<void> = Promise.resolve();
  private readonly launchPromise: Promise<void>;

  constructor(
    private readonly options: {
      path: string;
      size: {
        width: number;
        height: number;
      };
      captureFallbackFrame?: () => Promise<Buffer | null>;
    }
  ) {
    if (!options.path.endsWith(".webm")) {
      throw new Error("File must have .webm extension");
    }
    this.launchPromise = this.launch();
  }

  async ready(): Promise<void> {
    await this.launchPromise;
  }

  writeFrame(frame: Buffer, timestamp: number): void {
    void this.launchPromise.then(
      () => {
        this.queueFrame(frame, timestamp);
      },
      () => {}
    );
  }

  async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }

    await this.launchPromise;
    if (this.stopped) {
      return;
    }

    if (!this.lastFrame) {
      const fallbackFrame = (await this.options.captureFallbackFrame?.().catch(() => null)) ?? null;
      this.queueFrame(fallbackFrame ?? FALLBACK_JPEG_1X1_WHITE, Date.now());
    }
    if (!this.lastFrame) {
      throw new Error("Failed to initialize video recording.");
    }

    const paddingSeconds = Math.max((Date.now() - this.lastWriteNodeTime) / 1000, 1);
    this.queueFrame(Buffer.alloc(0), this.lastFrame.timestamp + paddingSeconds * 1000);
    this.stopped = true;
    await this.lastWritePromise;
    await this.closeProcess();
  }

  private async launch(): Promise<void> {
    await mkdir(dirname(this.options.path), { recursive: true });

    const ffmpegPath = resolveFfmpegPath();
    const { width, height } = this.options.size;
    const args = [
      "-loglevel",
      "error",
      "-f",
      "image2pipe",
      "-avioflags",
      "direct",
      "-fpsprobesize",
      "0",
      "-probesize",
      "32",
      "-analyzeduration",
      "0",
      "-c:v",
      "mjpeg",
      "-i",
      "pipe:0",
      "-y",
      "-an",
      "-r",
      String(VIDEO_RECORDING_FPS),
      "-c:v",
      "vp8",
      "-qmin",
      "0",
      "-qmax",
      "50",
      "-crf",
      "8",
      "-deadline",
      "realtime",
      "-speed",
      "8",
      "-b:v",
      "1M",
      "-threads",
      "1",
      "-vf",
      `pad=${width}:${height}:0:0:gray,crop=${width}:${height}:0:0`,
      this.options.path
    ];

    await new Promise<void>((resolve, reject) => {
      const process = spawn(ffmpegPath, args, {
        stdio: ["pipe", "ignore", "pipe"]
      });
      this.process = process;
      this.unregisterProcessCleanup = registerTestBrowserProcessForCleanup(process);

      process.once("spawn", () => {
        resolve();
      });
      process.once("exit", () => {
        this.unregisterProcessCleanup?.();
        this.unregisterProcessCleanup = null;
      });
      process.once("error", (error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          reject(new Error(formatMissingFfmpegMessage()));
          return;
        }
        reject(error);
      });
      process.stderr.on("data", (chunk: Buffer | string) => {
        this.stderr += chunk.toString();
      });
    });
  }

  private queueFrame(frame: Buffer, timestamp: number): void {
    if (!this.process || this.stopped) {
      return;
    }

    if (!this.firstFrameTimestamp) {
      this.firstFrameTimestamp = timestamp;
    }

    const frameNumber = Math.floor(
      ((timestamp - this.firstFrameTimestamp) / 1000) * VIDEO_RECORDING_FPS
    );

    if (this.lastFrame) {
      const repeatCount = Math.max(0, frameNumber - this.lastFrame.frameNumber);
      for (let index = 0; index < repeatCount; index += 1) {
        this.frameQueue.push(this.lastFrame.buffer);
      }
      this.lastWritePromise = this.lastWritePromise.then(() => this.flushFrameQueue());
    }

    this.lastFrame = {
      buffer: frame,
      timestamp,
      frameNumber
    };
    this.lastWriteNodeTime = Date.now();
  }

  private async flushFrameQueue(): Promise<void> {
    while (this.frameQueue.length > 0) {
      const frame = this.frameQueue.shift();
      if (!frame) {
        continue;
      }
      await this.writeBuffer(frame);
    }
  }

  private async writeBuffer(frame: Buffer): Promise<void> {
    if (!this.process) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      this.process!.stdin.write(frame, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  private async closeProcess(): Promise<void> {
    if (!this.process) {
      return;
    }

    const process = this.process;
    this.process = null;
    const unregisterProcessCleanup = this.unregisterProcessCleanup;
    this.unregisterProcessCleanup = null;

    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        process.removeListener("exit", handleExit);
        process.removeListener("error", handleError);
        unregisterProcessCleanup?.();
        if (error) {
          reject(error);
          return;
        }
        resolve();
      };
      const handleError = (error: Error) => {
        finish(error);
      };
      const handleExit = (code: number | null, signal: NodeJS.Signals | null) => {
        if (code === 0 || code === null) {
          finish();
          return;
        }
        const details = this.stderr.trim();
        finish(
          new Error(
            details || `ffmpeg exited with code ${String(code)}${signal ? ` signal ${signal}` : ""}`
          )
        );
      };

      process.once("exit", handleExit);
      process.once("error", handleError);
      process.stdin.end();
    });
  }
}
