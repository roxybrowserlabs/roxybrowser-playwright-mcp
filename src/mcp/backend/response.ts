import { writeFile } from "node:fs/promises";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { formatSnapshot, formatTabs } from "../format.js";
import type { BrowserSnapshot } from "../types.js";
import type { Context } from "./context.js";

export class Response {
  private readonly results: string[] = [];
  private readonly errors: string[] = [];
  private readonly code: string[] = [];
  private readonly images: Array<{ data: string; mimeType: "image/png" | "image/jpeg" }> = [];
  private structuredContent: Record<string, unknown> | undefined;
  private includeSnapshot: "none" | "full" = "none";
  private fullSnapshot:
    | {
        filename?: string;
        target?: string;
        depth?: number;
        boxes?: boolean;
      }
    | undefined;
  private isClose = false;
  private rawResults = false;

  constructor(
    private readonly context: Context,
    readonly toolName: string,
    readonly toolArgs: Record<string, unknown>
  ) {}

  addTextResult(text: string): void {
    this.results.push(text);
  }

  addStructuredResult(content: Record<string, unknown>): void {
    this.structuredContent = content;
  }

  addError(error: string): void {
    this.errors.push(error);
  }

  addCode(code: string): void {
    this.code.push(code);
  }

  addImageResult(data: string, mimeType: "image/png" | "image/jpeg"): void {
    this.images.push({ data, mimeType });
  }

  setClose(): void {
    this.isClose = true;
  }

  setRawResults(): void {
    this.rawResults = true;
  }

  setIncludeSnapshot(): void {
    this.includeSnapshot = this.context.config.snapshot?.mode ?? "full";
  }

  setIncludeFullSnapshot(filename?: string, target?: string, depth?: number, boxes?: boolean): void {
    this.includeSnapshot = "none";
    this.fullSnapshot = {
      ...(filename !== undefined ? { filename } : {}),
      ...(target !== undefined ? { target } : {}),
      ...(depth !== undefined ? { depth } : {}),
      ...(boxes !== undefined ? { boxes } : {})
    };
  }

  async serialize(): Promise<CallToolResult & { isClose?: boolean }> {
    const sections: string[] = [];

    if (this.errors.length) {
      sections.push("### Error", ...this.errors);
    }

    if (this.rawResults) {
      if (this.results.length) {
        sections.push(...this.results);
      }
      return {
        content: [
          { type: "text", text: sections.join("\n") },
          ...this.images.map((image) => ({
            type: "image" as const,
            data: image.data,
            mimeType: image.mimeType
          }))
        ],
        ...(this.structuredContent ? { structuredContent: this.structuredContent } : {}),
        ...(this.isClose ? { isClose: true } : {}),
        ...(this.errors.length ? { isError: true } : {})
      };
    }

    if (this.results.length) {
      if (sections.length) {
        sections.push("");
      }
      sections.push("### Result", ...this.results);
    }

    if (this.code.length) {
      if (sections.length) {
        sections.push("");
      }
      sections.push("### Code", "```js", ...this.code, "```");
    }

    if (this.includeSnapshot === "full") {
      if (!await this.context.runtime.hasDialog()) {
        const snapshot = await reconcileSnapshotWithTabs(
          this.context,
          await this.context.runtime.snapshot()
        );
        if (sections.length) {
          sections.push("");
        }
        sections.push(formatSnapshot(snapshot));
      }
    }

    if (this.fullSnapshot) {
      let snapshot = await reconcileSnapshotWithTabs(
        this.context,
        await this.context.runtime.snapshot({
        ...(this.fullSnapshot.target !== undefined ? { target: this.fullSnapshot.target } : {}),
        ...(this.fullSnapshot.depth !== undefined ? { depth: this.fullSnapshot.depth } : {}),
        ...(this.fullSnapshot.boxes !== undefined ? { boxes: this.fullSnapshot.boxes } : {})
        })
      );
      if (
        !this.fullSnapshot.filename
        && snapshot.retryable
        && snapshot.text.trim().length === 0
        && snapshot.url
        && snapshot.url !== "about:blank"
      ) {
        snapshot = await reconcileSnapshotWithTabs(
          this.context,
          await this.context.runtime.snapshot({
            ...(this.fullSnapshot.target !== undefined ? { target: this.fullSnapshot.target } : {}),
            ...(this.fullSnapshot.depth !== undefined ? { depth: this.fullSnapshot.depth } : {}),
            ...(this.fullSnapshot.boxes !== undefined ? { boxes: this.fullSnapshot.boxes } : {})
          })
        );
      }
      if (this.fullSnapshot.filename) {
        const resolvedFilename = await this.context.resolveOutputFile(this.fullSnapshot.filename, "snapshot");
        await writeFile(resolvedFilename, snapshot.text);
        if (sections.length) {
          sections.push("");
        }
        sections.push("### Result", `Saved snapshot to "${resolvedFilename}".`);
      } else {
        const tabs = await this.context.runtime.listTabs();
        if (sections.length) {
          sections.push("");
        }
        if (tabs.length > 1) {
          sections.push(formatTabs(tabs), "");
        }
        sections.push(formatSnapshot(snapshot));
      }
    }

    return {
      content: [
        { type: "text", text: sections.join("\n") },
        ...this.images.map((image) => ({
          type: "image" as const,
          data: image.data,
          mimeType: image.mimeType
        }))
      ],
      ...(this.structuredContent ? { structuredContent: this.structuredContent } : {}),
      ...(this.isClose ? { isClose: true } : {}),
      ...(this.errors.length ? { isError: true } : {})
    };
  }
}

async function reconcileSnapshotWithTabs(
  context: Context,
  snapshot: BrowserSnapshot
): Promise<BrowserSnapshot> {
  const tabs = await context.runtime.listTabs();
  const activeTab = tabs.find((tab) => tab.active);
  if (!activeTab) {
    return snapshot;
  }

  return {
    ...snapshot,
    title: activeTab.title || snapshot.title,
    url: activeTab.url || snapshot.url
  };
}
