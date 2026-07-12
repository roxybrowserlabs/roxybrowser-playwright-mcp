import { urlMatches } from "../urlMatch.js";
import { HarRecorder } from "./harRecorder.js";
import type { HarOptions, NetworkRecord } from "./types.js";

export class HarTracer {
  private recorder: HarRecorder | null = null;

  start(path: string, options: HarOptions = {}): string {
    if (this.recorder) {
      throw new Error("HAR recording has already been started");
    }
    if (options.resourcesDir && path.endsWith(".zip")) {
      throw new Error("resourcesDir option is not compatible with a .zip har file");
    }
    this.recorder = new HarRecorder(path, options);
    return path;
  }

  addPage(page: { id: string; title: string }): void {
    this.recorder?.addPage({
      id: page.id,
      startedDateTime: new Date().toISOString(),
      title: page.title
    });
  }

  onEntryFinished(record: NetworkRecord): void {
    if (!this.recorder || !urlMatches(undefined, record.url, this.recorder.options.urlFilter)) {
      return;
    }
    this.recorder.addEntry(record);
  }

  async stop(): Promise<void> {
    const recorder = this.recorder;
    if (!recorder) {
      throw new Error("HAR recording has not been started");
    }
    this.recorder = null;
    await recorder.write();
  }

  async exportAll(): Promise<void> {
    if (this.recorder) {
      await this.stop();
    }
  }
}
