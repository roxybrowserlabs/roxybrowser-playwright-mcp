import type { McpRuntime } from "../runtime.js";
import type { SnapshotMode } from "../types.js";
import type { ToolCapability } from "./tool.js";
import { Tab } from "./tab.js";

export type ContextConfig = {
  capabilities?: ToolCapability[];
  skillMode?: boolean;
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
}
