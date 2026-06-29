import type { McpRuntime } from "../runtime.js";
import type { SnapshotMode } from "../types.js";
import type { ToolCapability } from "./tool.js";
import { Tab } from "./tab.js";
import { configuredOutputDir, resolveOutputFilePath, resolveTempFilePath } from "../output.js";

export type ContextConfig = {
  capabilities?: ToolCapability[];
  skillMode?: boolean;
  outputDir?: string;
  tempDir?: string;
  snapshot?: {
    mode?: SnapshotMode;
  };
  timeouts?: {
    action?: number;
    navigation?: number;
    expect?: number;
  };
};

export class Context {
  readonly config: ContextConfig;

  constructor(
    readonly runtime: McpRuntime,
    config: ContextConfig = {}
  ) {
    this.config = config;
  }

  currentTabOrDie(): Tab {
    this.runtime.requireConnected();
    this.runtime.requireActiveTab();
    return new Tab(this);
  }

  async ensureTab(): Promise<Tab> {
    const tabs = await this.runtime.listTabs();
    if (!tabs.some((tab) => tab.active)) {
      await this.runtime.newTab();
    }
    return new Tab(this);
  }

  outputDir(): string {
    return configuredOutputDir({
      outputDir: this.config.outputDir ?? this.runtime.getOutputDir()
    });
  }

  tempDir(): string {
    return this.runtime.getTempDir();
  }

  async resolveOutputFile(filename: string): Promise<string> {
    return resolveOutputFilePath(filename, {
      outputDir: this.config.outputDir ?? this.runtime.getOutputDir()
    });
  }

  async resolveTempFile(filename: string): Promise<string> {
    return resolveTempFilePath(filename, {
      tempDir: this.config.tempDir ?? this.runtime.getTempDir()
    });
  }
}
