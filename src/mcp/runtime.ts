import { connectBrowserSession } from "./connectedBrowser.js";
import { McpToolError } from "./errors.js";
import type {
  BrowserSessionFactory,
  BrowserSnapshot,
  BrowserSnapshotRequest,
  BrowserSnapshotToolArgs,
  BrowserSnapshotTarget,
  BrowserTab,
  ClickTarget,
  CreateRoxyBrowserMcpServerOptions,
  SessionClickOptions,
  SnapshotCacheEntry
} from "./types.js";
import { resolveHumanizationOptions, jitter } from "../human/profile.js";
import type { HumanizationOptions } from "../types/options.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class McpRuntime {
  private connection:
    | {
        session: Awaited<ReturnType<BrowserSessionFactory>>;
      }
    | undefined;
  private tabs: BrowserTab[] = [];
  private snapshotCache: SnapshotCacheEntry | undefined;

  constructor(private readonly sessionFactory: BrowserSessionFactory = connectBrowserSession) {}

  async connect(args: Parameters<BrowserSessionFactory>[0]): Promise<{
    browserName: string;
    protocol: string;
    version: string;
    tabs: BrowserTab[];
    snapshot?: BrowserSnapshot;
  }> {
    await this.close();
    const session = await this.sessionFactory(args);
    this.connection = {
      session
    };
    this.tabs = await session.listTabs();
    const version = await session.version();
    const snapshot = this.tabs.some((tab) => tab.active)
      ? await this.snapshot()
      : undefined;

    return {
      browserName: session.browserName,
      protocol: session.protocol,
      version,
      tabs: this.tabs,
      ...(snapshot ? { snapshot } : {})
    };
  }

  async listTabs(): Promise<BrowserTab[]> {
    const session = this.requireConnected();
    this.tabs = await session.listTabs();
    if (!this.tabs.some((tab) => tab.active)) {
      this.invalidateSnapshot();
    }
    return this.tabs;
  }

  async newTab(url?: string): Promise<{ tabs: BrowserTab[]; snapshot?: BrowserSnapshot }> {
    const session = this.requireConnected();
    this.invalidateSnapshot();
    this.tabs = await session.newTab(url);
    const snapshot = this.tabs.some((tab) => tab.active)
      ? await this.snapshot()
      : undefined;
    return snapshot
      ? {
          tabs: this.tabs,
          snapshot
        }
      : {
          tabs: this.tabs
        };
  }

  async selectTab(index: number): Promise<{ tabs: BrowserTab[]; snapshot?: BrowserSnapshot }> {
    const session = this.requireConnected();
    const tabs = await this.listTabs();
    const tab = tabs[index];
    if (!tab) {
      throw new McpToolError("invalid_tab_index", `Tab index ${index} does not exist.`);
    }
    this.invalidateSnapshot();
    this.tabs = await session.selectTab(tab.id);
    const snapshot = await this.snapshot();
    return {
      tabs: this.tabs,
      snapshot
    };
  }

  async closeTab(index: number): Promise<{ tabs: BrowserTab[]; snapshot?: BrowserSnapshot }> {
    const session = this.requireConnected();
    const tabs = await this.listTabs();
    const tab = tabs[index];
    if (!tab) {
      throw new McpToolError("invalid_tab_index", `Tab index ${index} does not exist.`);
    }
    this.invalidateSnapshot();
    this.tabs = await session.closeTab(tab.id);
    const snapshot = this.tabs.some((candidate) => candidate.active)
      ? await this.snapshot()
      : undefined;
    return snapshot
      ? {
          tabs: this.tabs,
          snapshot
        }
      : {
          tabs: this.tabs
        };
  }

  async snapshot(args: BrowserSnapshotToolArgs = {}): Promise<BrowserSnapshot> {
    const session = this.requireConnected();
    const activeTab = this.requireActiveTab();
    const requestKey = this.snapshotRequestKey(args);
    if (
      this.snapshotCache &&
      this.snapshotCache.tabId === activeTab.id &&
      this.snapshotCache.requestKey === requestKey
    ) {
      return {
        text: this.snapshotCache.text,
        refs: { ...this.snapshotCache.refs },
        title: this.snapshotCache.title,
        url: this.snapshotCache.url
      };
    }

    const request: BrowserSnapshotRequest = {
      ...(args.boxes !== undefined ? { boxes: args.boxes } : {}),
      ...(args.depth !== undefined ? { depth: args.depth } : {}),
      ...(args.target ? { target: this.resolveSnapshotTarget(args.target) } : {})
    };
    const snapshot = await session.snapshot(request);
    this.snapshotCache = {
      tabId: activeTab.id,
      requestKey,
      text: snapshot.text,
      refs: { ...snapshot.refs },
      title: snapshot.title,
      url: snapshot.url
    };
    return snapshot;
  }

  async click(
    target: string,
    opts?: {
      element?: string;
      doubleClick?: boolean;
      button?: "left" | "right" | "middle";
      modifiers?: string[];
      human?: { profile?: string };
    }
  ): Promise<BrowserSnapshot> {
    const session = this.requireConnected();
    const resolved = this.resolveTarget(target);
    const humanOpts = resolveHumanizationOptions(opts?.human as HumanizationOptions | undefined);

    await session.hover(resolved);
    const hoverDelayMs = jitter(humanOpts.hoverBeforeClickMs);
    if (hoverDelayMs > 0) await delay(hoverDelayMs);

    await session.click(resolved, {
      ...(opts?.doubleClick !== undefined ? { doubleClick: opts.doubleClick } : {}),
      ...(opts?.button !== undefined ? { button: opts.button } : {}),
      ...(opts?.modifiers !== undefined ? { modifiers: opts.modifiers as SessionClickOptions["modifiers"] } : {}),
      clickHoldMs: jitter(humanOpts.clickHoldMs)
    } as SessionClickOptions);

    this.invalidateSnapshot();
    return this.snapshot();
  }

  async hover(ref: string): Promise<void> {
    const session = this.requireConnected();
    const resolved = this.resolveTarget(ref);
    await session.hover(resolved);
    this.invalidateSnapshot();
  }

  invalidateSnapshot(): void {
    this.snapshotCache = undefined;
  }

  async close(): Promise<void> {
    this.invalidateSnapshot();
    this.tabs = [];
    if (!this.connection) {
      return;
    }

    const session = this.connection.session;
    this.connection = undefined;
    await session.close();
  }

  requireConnected() {
    if (!this.connection) {
      throw new McpToolError(
        "not_connected",
        'No browser is connected. Call "roxy_browser_connect" first.'
      );
    }
    return this.connection.session;
  }

  requireActiveTab(): BrowserTab {
    const activeTab = this.tabs.find((tab) => tab.active);
    if (!activeTab) {
      throw new McpToolError("no_active_tab", "No active tab is available.");
    }
    return activeTab;
  }

  private resolveTarget(target: string): ClickTarget {
    const activeTab = this.requireActiveTab();

    if (/^(f\d+)?e\d+$/.test(target)) {
      if (!this.snapshotCache || this.snapshotCache.tabId !== activeTab.id) {
        throw new McpToolError(
          "stale_ref",
          'No fresh snapshot is available for the active tab. Call "browser_snapshot" again.'
        );
      }
      const token = this.snapshotCache.refs[target];
      if (!token) {
        throw new McpToolError(
          "stale_ref",
          `Ref "${target}" is no longer valid. Call "browser_snapshot" again.`
        );
      }
      return { nodeToken: token };
    }

    return { selector: target };
  }

  private resolveRef(ref: string): string {
    const activeTab = this.requireActiveTab();
    if (!this.snapshotCache || this.snapshotCache.tabId !== activeTab.id) {
      throw new McpToolError(
        "stale_ref",
        'No fresh snapshot is available for the active tab. Call "browser_snapshot" again.'
      );
    }

    const token = this.snapshotCache.refs[ref];
    if (!token) {
      throw new McpToolError(
        "stale_ref",
        `Ref "${ref}" is no longer valid. Call "browser_snapshot" again.`
      );
    }

    return token;
  }

  private resolveSnapshotTarget(target: string): BrowserSnapshotTarget {
    const activeTab = this.requireActiveTab();
    if (this.snapshotCache && this.snapshotCache.tabId === activeTab.id) {
      const token = this.snapshotCache.refs[target];
      if (token) {
        return {
          raw: target,
          nodeToken: token
        };
      }
    }

    if (/^e\d+$/.test(target)) {
      if (!this.snapshotCache || this.snapshotCache.tabId !== activeTab.id) {
        throw new McpToolError(
          "stale_ref",
          'No fresh snapshot is available for the active tab. Call "browser_snapshot" again.'
        );
      }

      throw new McpToolError(
        "stale_ref",
        `Ref "${target}" is no longer valid. Call "browser_snapshot" again.`
      );
    }

    return {
      raw: target,
      selector: target
    };
  }

  private snapshotRequestKey(args: BrowserSnapshotToolArgs): string {
    return JSON.stringify({
      target: args.target ?? null,
      depth: args.depth ?? null,
      boxes: args.boxes ?? null
    });
  }
}

export class McpRuntimeManager {
  private readonly runtimes = new Map<string, McpRuntime>();

  constructor(private readonly sessionFactory?: CreateRoxyBrowserMcpServerOptions["sessionFactory"]) {}

  getRuntime(sessionId = "default"): McpRuntime {
    const existing = this.runtimes.get(sessionId);
    if (existing) {
      return existing;
    }

    const runtime = new McpRuntime(this.sessionFactory);
    this.runtimes.set(sessionId, runtime);
    return runtime;
  }

  async closeRuntime(sessionId = "default"): Promise<void> {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) {
      return;
    }

    this.runtimes.delete(sessionId);
    await runtime.close();
  }

  async closeAll(): Promise<void> {
    const runtimes = Array.from(this.runtimes.values());
    this.runtimes.clear();
    await Promise.all(runtimes.map(async (runtime) => runtime.close()));
  }
}
