import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { appendZipFile, calculateSha1, writeZipFile } from "./zip.js";
import type {
  ClientSideCallMetadata,
  LocalUtilsTracingStartedParams,
  LocalUtilsZipParams
} from "./types.js";

type StackSession = {
  callStacks: ClientSideCallMetadata[];
  file: string;
  live?: boolean;
  tmpDir?: string;
  writer: Promise<void>;
};

export class LocalUtils {
  private readonly stackSessions = new Map<string, StackSession>();

  async zip(params: LocalUtilsZipParams): Promise<void> {
    const entries: Array<{ name: string; body: Buffer }> = [];
    for (const entry of params.entries) {
      try {
        entries.push({ name: entry.name, body: await readFile(entry.value) });
      } catch {
      }
    }

    const stackSession = params.stacksId ? this.stackSessions.get(params.stacksId) : undefined;
    if (stackSession?.callStacks.length) {
      await stackSession.writer;
      entries.push({
        name: "trace.stacks",
        body: Buffer.from(JSON.stringify(stackSession.callStacks))
      });
    }

    if (params.includeSources) {
      const sourceFiles = new Set<string>(params.additionalSources);
      for (const { stack } of stackSession?.callStacks ?? []) {
        for (const frame of stack ?? []) {
          sourceFiles.add(frame.file);
        }
      }
      for (const sourceFile of sourceFiles) {
        try {
          entries.push({
            name: `resources/src@${calculateSha1(sourceFile)}.txt`,
            body: await readFile(sourceFile)
          });
        } catch {
        }
      }
    }

    if (params.mode === "write") {
      await writeZipFile(params.zipFile, entries);
    } else {
      await appendZipFile(params.zipFile, entries);
    }
    await this.deleteStackSession(params.stacksId);
  }

  async tracingStarted(params: LocalUtilsTracingStartedParams): Promise<{ stacksId: string }> {
    const tmpDir = params.tracesDir ? undefined : await mkdtemp(join(tmpdir(), "playwright-tracing-"));
    const traceStacksFile = join(params.tracesDir ?? tmpDir!, `${params.traceName}.stacks`);
    await mkdir(dirname(traceStacksFile), { recursive: true });
    this.stackSessions.set(traceStacksFile, {
      callStacks: [],
      file: traceStacksFile,
      ...(params.live !== undefined ? { live: params.live } : {}),
      ...(tmpDir !== undefined ? { tmpDir } : {}),
      writer: Promise.resolve()
    });
    return { stacksId: traceStacksFile };
  }

  async traceDiscarded(params: { stacksId?: string }): Promise<void> {
    await this.deleteStackSession(params.stacksId);
  }

  addStackToTracingNoReply(params: { callData: ClientSideCallMetadata }): void {
    for (const session of this.stackSessions.values()) {
      session.callStacks.push(params.callData);
      if (session.live) {
        session.writer = session.writer.then(() =>
          writeFile(session.file, JSON.stringify(session.callStacks))
        );
      }
    }
  }

  async harUnzip(params: { zipFile: string; harFile: string; resourcesDir?: string }): Promise<void> {
    await mkdir(dirname(params.harFile), { recursive: true });
    await writeFile(params.harFile, await readFile(params.zipFile));
    await unlink(params.zipFile).catch(() => {});
  }

  private async deleteStackSession(stacksId?: string): Promise<void> {
    const session = stacksId ? this.stackSessions.get(stacksId) : undefined;
    if (!session) {
      return;
    }
    await session.writer;
    this.stackSessions.delete(stacksId!);
    if (session.tmpDir) {
      await rm(session.tmpDir, { recursive: true, force: true });
    }
  }
}
