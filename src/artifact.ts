import { createReadStream, type ReadStream } from "node:fs";
import { copyFile, rm } from "node:fs/promises";

type SaveCallback = (localPath: string, error?: Error) => Promise<void>;

export class RoxyArtifact {
  private finished = false;
  private deleted = false;
  private failureError: Error | undefined;
  private saveCallbacks: SaveCallback[] = [];
  private resolveFinished!: () => void;
  private readonly finishedPromise = new Promise<void>((resolve) => {
    this.resolveFinished = resolve;
  });

  constructor(
    private readonly localPath: string,
    private readonly cancelCallback?: () => Promise<void>
  ) {}

  async pathAfterFinished(): Promise<string> {
    await this.finishedPromise;
    if (this.failureError) {
      throw this.failureError;
    }
    return this.localPath;
  }

  async saveAs(targetPath: string): Promise<void> {
    if (this.deleted) {
      throw new Error("File already deleted. Save before deleting.");
    }
    if (this.failureError) {
      throw this.failureError;
    }
    if (this.finished) {
      await copyFile(this.localPath, targetPath);
      return;
    }
    await new Promise<void>((resolve, reject) => {
      this.saveCallbacks.push(async (localPath, error) => {
        try {
          if (error) {
            throw error;
          }
          await copyFile(localPath, targetPath);
          resolve();
        } catch (caught) {
          reject(caught);
        }
      });
    });
  }

  async createReadStream(): Promise<ReadStream | null> {
    const file = await this.pathAfterFinished();
    return createReadStream(file);
  }

  async failure(): Promise<string | null> {
    await this.finishedPromise;
    return this.failureError?.message ?? null;
  }

  async cancel(): Promise<void> {
    await this.cancelCallback?.();
  }

  async delete(): Promise<void> {
    if (this.deleted) {
      return;
    }
    this.deleted = true;
    const file = await this.pathAfterFinished().catch(() => undefined);
    if (file) {
      await rm(file, { force: true });
    }
  }

  async reportFinished(error?: Error): Promise<void> {
    if (this.finished) {
      return;
    }
    this.finished = true;
    this.failureError = error;
    for (const callback of this.saveCallbacks) {
      await callback(this.localPath, error);
    }
    this.saveCallbacks = [];
    this.resolveFinished();
  }
}
