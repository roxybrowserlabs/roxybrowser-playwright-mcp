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
  SnapshotCacheEntry,
  SnapshotMode
} from "./types.js";
import { resolveHumanizationOptions, jitter } from "../human/profile.js";
import type { HumanizationOptions } from "../types/options.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function staleRefMessage(ref: string): string {
  return `Ref ${ref} not found in the current page snapshot. Try capturing new snapshot.`;
}

export class McpRuntime {
  private connection:
    | {
        session: Awaited<ReturnType<BrowserSessionFactory>>;
      }
    | undefined;
  private tabs: BrowserTab[] = [];
  private snapshotCache: SnapshotCacheEntry | undefined;
  private readonly snapshotMode: SnapshotMode;

  constructor(
    private readonly sessionFactory: BrowserSessionFactory = connectBrowserSession,
    options: { snapshotMode?: SnapshotMode } = {}
  ) {
    this.snapshotMode = options.snapshotMode ?? "full";
  }

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
    const snapshot = this.snapshotMode !== "none" && this.tabs.some((tab) => tab.active)
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
      url: snapshot.url,
      ...(snapshot.console ? { console: { ...snapshot.console } } : {}),
      ...(snapshot.consoleLink ? { consoleLink: snapshot.consoleLink } : {})
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
  ): Promise<BrowserSnapshot | undefined> {
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
    if (this.snapshotMode === "none") {
      return undefined;
    }
    return this.snapshot();
  }

  async hover(ref: string): Promise<void> {
    const session = this.requireConnected();
    const resolved = this.resolveTarget(ref);
    await session.hover(resolved);
    this.invalidateSnapshot();
  }

  async navigate(url: string): Promise<BrowserSnapshot | undefined> {
    const session = this.requireConnected();
    await session.navigate(url);
    this.invalidateSnapshot();
    if (this.snapshotMode === "none") {
      return undefined;
    }
    return this.snapshot();
  }

  async type(
    ref: string,
    text: string,
    opts?: { submit?: boolean }
  ): Promise<BrowserSnapshot | undefined> {
    const session = this.requireConnected();
    const resolved = this.resolveTarget(ref);
    await session.type(resolved, text, opts);
    this.invalidateSnapshot();
    if (this.snapshotMode === "none") {
      return undefined;
    }
    return this.snapshot();
  }

  async pressKey(
    key: string,
    modifiers?: Array<"Alt" | "Control" | "ControlOrMeta" | "Meta" | "Shift">
  ): Promise<BrowserSnapshot | undefined> {
    const session = this.requireConnected();
    await session.pressKey(key, modifiers);
    this.invalidateSnapshot();
    if (this.snapshotMode === "none") {
      return undefined;
    }
    return this.snapshot();
  }

  async selectOption(
    ref: string,
    values: string[]
  ): Promise<{ selected: string[]; snapshot?: BrowserSnapshot }> {
    const session = this.requireConnected();
    const resolved = this.resolveTarget(ref);
    const selected = await session.selectOption(resolved, values);
    this.invalidateSnapshot();
    if (this.snapshotMode === "none") {
      return { selected };
    }
    return { selected, snapshot: await this.snapshot() };
  }

  async check(
    ref: string,
    checked: boolean
  ): Promise<BrowserSnapshot | undefined> {
    const session = this.requireConnected();
    const resolved = this.resolveTarget(ref);
    await session.check(resolved, checked);
    this.invalidateSnapshot();
    if (this.snapshotMode === "none") {
      return undefined;
    }
    return this.snapshot();
  }

  async goBack(): Promise<BrowserSnapshot | undefined> {
    const session = this.requireConnected();
    await session.goBack();
    this.invalidateSnapshot();
    if (this.snapshotMode === "none") {
      return undefined;
    }
    return this.snapshot();
  }

  async goForward(): Promise<BrowserSnapshot | undefined> {
    const session = this.requireConnected();
    await session.goForward();
    this.invalidateSnapshot();
    if (this.snapshotMode === "none") {
      return undefined;
    }
    return this.snapshot();
  }

  async scroll(
    ref: string | null,
    deltaX: number,
    deltaY: number
  ): Promise<BrowserSnapshot | undefined> {
    const session = this.requireConnected();
    const resolved = ref !== null ? this.resolveTarget(ref) : null;
    await session.scroll(resolved, deltaX, deltaY);
    this.invalidateSnapshot();
    if (this.snapshotMode === "none") {
      return undefined;
    }
    return this.snapshot();
  }

  async takeScreenshot(): Promise<string> {
    const session = this.requireConnected();
    return session.screenshot();
  }

  async uploadFile(ref: string, paths: string[]): Promise<BrowserSnapshot | undefined> {
    const session = this.requireConnected();
    const resolved = this.resolveTarget(ref);
    await session.uploadFile(resolved, paths);
    this.invalidateSnapshot();
    if (this.snapshotMode === "none") {
      return undefined;
    }
    return this.snapshot();
  }

  async waitFor(
    condition: { text?: string; url?: string },
    timeoutMs = 5000
  ): Promise<BrowserSnapshot> {
    const deadline = Date.now() + timeoutMs;
    const poll = async (): Promise<BrowserSnapshot> => {
      this.invalidateSnapshot();
      const snap = await this.snapshot();
      if (condition.text && !snap.text.includes(condition.text)) {
        if (Date.now() >= deadline) {
          throw new McpToolError(
            "timeout",
            `Timed out after ${timeoutMs}ms waiting for text "${condition.text}" to appear.`
          );
        }
        await delay(250);
        return poll();
      }
      if (condition.url && !snap.url.includes(condition.url)) {
        if (Date.now() >= deadline) {
          throw new McpToolError(
            "timeout",
            `Timed out after ${timeoutMs}ms waiting for URL to contain "${condition.url}".`
          );
        }
        await delay(250);
        return poll();
      }
      return snap;
    };
    return poll();
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
        throw new McpToolError("stale_ref", staleRefMessage(target));
      }
      const token = this.snapshotCache.refs[target];
      if (!token) {
        throw new McpToolError("stale_ref", staleRefMessage(target));
      }
      return { nodeToken: token };
    }

    return { selector: target };
  }

  private resolveRef(ref: string): string {
    const activeTab = this.requireActiveTab();
    if (!this.snapshotCache || this.snapshotCache.tabId !== activeTab.id) {
      throw new McpToolError("stale_ref", staleRefMessage(ref));
    }

    const token = this.snapshotCache.refs[ref];
    if (!token) {
      throw new McpToolError("stale_ref", staleRefMessage(ref));
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

    if (/^(f\d+)?e\d+$/.test(target)) {
      throw new McpToolError("stale_ref", staleRefMessage(target));
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

  constructor(
    private readonly sessionFactory?: CreateRoxyBrowserMcpServerOptions["sessionFactory"],
    private readonly options: { snapshotMode?: SnapshotMode } = {}
  ) {}

  getRuntime(sessionId = "default"): McpRuntime {
    const existing = this.runtimes.get(sessionId);
    if (existing) {
      return existing;
    }

    const runtime = new McpRuntime(this.sessionFactory, {
      ...(this.options.snapshotMode !== undefined ? { snapshotMode: this.options.snapshotMode } : {})
    });
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
