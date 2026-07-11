import type { ReadStream } from "node:fs";
import type { Page } from "./types/api.js";
import type { RoxyArtifact } from "./artifact.js";

export class RoxyDownload {
  constructor(
    private readonly downloadPage: Page,
    private readonly downloadUrl: string,
    private readonly filename: string,
    private readonly artifact: RoxyArtifact
  ) {}

  page(): Page {
    return this.downloadPage;
  }

  url(): string {
    return this.downloadUrl;
  }

  suggestedFilename(): string {
    return this.filename;
  }

  path(): Promise<string> {
    return this.artifact.pathAfterFinished();
  }

  saveAs(path: string): Promise<void> {
    return this.artifact.saveAs(path);
  }

  failure(): Promise<string | null> {
    return this.artifact.failure();
  }

  createReadStream(): Promise<ReadStream | null> {
    return this.artifact.createReadStream();
  }

  cancel(): Promise<void> {
    return this.artifact.cancel();
  }

  delete(): Promise<void> {
    return this.artifact.delete();
  }
}
