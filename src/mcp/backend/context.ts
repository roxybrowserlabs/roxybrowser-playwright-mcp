import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { McpRuntime } from "../runtime.js";
import type { CodegenMode, ImageResponseMode, SessionScreenshotMimeType, SnapshotMode } from "../types.js";
import type { AssetKind, AssetOptions } from "../../assets/types.js";
import type { BrowserContextOptions } from "../../types/options.js";
import type { ToolCapability } from "./tool.js";
import { Tab } from "./tab.js";
import { escapeWithQuotes } from "./utils.js";

export type ContextConfig = AssetOptions & {
  capabilities?: ToolCapability[];
  imageResponses?: ImageResponseMode;
  codegen?: CodegenMode;
  outputMaxSize?: number;
  testIdAttribute?: string;
  skillMode?: boolean;
  initPage?: string[];
  initScript?: string[];
  snapshot?: {
    mode?: SnapshotMode;
  };
  timeouts?: {
    action?: number;
    navigation?: number;
    expect?: number;
    settle?: number;
  };
  contextOptions?: BrowserContextOptions;
  secrets?: Record<string, string>;
};

type InitPageScreenshotOptions = {
  type?: "png" | "jpeg" | "webp";
  quality?: number;
  fullPage?: boolean;
  scale?: "css" | "device";
  target?: string;
};

type InitPageScreenshotResult = { data: string; mimeType: SessionScreenshotMimeType };

export function redactSecrets(text: string, secrets?: Record<string, string>): string {
  let redacted = text;
  for (const [secretName, secretValue] of Object.entries(secrets ?? {})) {
    if (!secretValue) {
      continue;
    }
    redacted = redacted.replaceAll(secretValue, `<secret>${secretName}</secret>`);
  }
  return redacted;
}

export class Context {
  readonly config: ContextConfig;
  private initPagePromise: Promise<void> | undefined;
  private readonly writtenFiles = new Set<string>();
  private readonly initPagePage = {
    setContent: async (html: string) => this.runtime.setContent(html),
    screenshot: async (options?: InitPageScreenshotOptions) => this.runtime.takeScreenshot(options)
  };

  constructor(
    readonly runtime: McpRuntime,
    config: ContextConfig = {}
  ) {
    this.config = config;
  }

  async currentTabOrDie(): Promise<Tab> {
    this.runtime.requireConnected();
    this.runtime.requireActiveTab();
    const tab = new Tab(this);
    await this.applyInitPageHooks(tab);
    return tab;
  }

  async ensureTab(): Promise<Tab> {
    const tabs = await this.runtime.listTabs();
    if (!tabs.some((tab) => tab.active)) {
      await this.runtime.newTab();
    }
    const tab = new Tab(this);
    await this.applyInitPageHooks(tab);
    return tab;
  }

  private async applyInitPageHooks(tab: Tab): Promise<void> {
    if (!this.initPagePromise) {
      this.initPagePromise = this.runInitPageHooks(tab);
    }
    await this.initPagePromise;
  }

  private async runInitPageHooks(tab: Tab): Promise<void> {
    for (const initPage of this.config.initPage ?? []) {
      try {
        const module = await import(pathToFileURL(initPage).href);
        const func = module.default;
        if (typeof func !== "function") {
          throw new Error("default export is not a function");
        }
        await func({
          page: this.initPagePage,
          tab,
          context: this
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to load init page "${initPage}": ${reason}`, { cause: error });
      }
    }
  }

  assetDir(kind: AssetKind): string {
    return this.runtime.getAssetManager().rootFor(kind);
  }

  async resolveOutputFile(filename: string, kind: AssetKind = "script"): Promise<string> {
    return (await this.runtime.getAssetManager().resolveFile(kind, filename)).absolutePath;
  }

  resolveInputFile(filename: string, kind: AssetKind = "script"): string {
    return this.runtime.getAssetManager().resolveExistingFile(kind, filename).absolutePath;
  }

  async resolveTempFile(filename: string): Promise<string> {
    return (await this.runtime.getAssetManager().resolveFile("temporary", filename)).absolutePath;
  }

  lookupSecret(secretName: string): { value: string; code: string } {
    const value = this.config.secrets?.[secretName];
    if (!value) {
      return { value: secretName, code: escapeWithQuotes(secretName) };
    }
    return {
      value,
      code: `process.env[${escapeWithQuotes(secretName)}]`
    };
  }

  redactSecrets(text: string): string {
    return redactSecrets(text, this.config.secrets);
  }

  async writeTextFile(filename: string, text: string): Promise<void> {
    await writeFile(filename, this.redactSecrets(text), "utf8");
    this.markWrittenFile(filename);
  }

  async takeScreenshot(options?: InitPageScreenshotOptions): Promise<InitPageScreenshotResult> {
    return this.initPagePage.screenshot(options);
  }

  async readTextFile(filename: string): Promise<string> {
    return readFile(filename, "utf8");
  }

  markWrittenFile(filename: string): void {
    this.writtenFiles.add(path.resolve(filename));
  }

  writtenOutputFiles(): Set<string> {
    return new Set(this.writtenFiles);
  }
}
