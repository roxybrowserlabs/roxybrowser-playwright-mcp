import { connectBrowserSession } from "./connectedBrowser.js";
import { McpToolError } from "./errors.js";
import { AssetManager } from "../assets/manager.js";
import type {
  BrowserConsoleEntry,
  BrowserNetworkRequest,
  BrowserSessionFactory,
  BrowserSnapshot,
  BrowserSnapshotRequest,
  BrowserSnapshotToolArgs,
  BrowserSnapshotTarget,
  BrowserTab,
  ClickTarget,
  ConnectedBrowserSession,
  CreateRoxyBrowserMcpServerOptions,
  SessionClickOptions,
  SnapshotCacheEntry,
  SnapshotMode
} from "./types.js";
import { resolveHumanizationOptions, jitter } from "../human/profile.js";
import type { AssetOptions } from "../assets/types.js";
import type { HumanizationOptions } from "../human/types.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function staleRefMessage(ref: string): string {
  return `Ref ${ref} not found in the current page snapshot. Try capturing new snapshot.`;
}

function normalizeNavigationUrl(url: string): string {
  try {
    new URL(url);
    return url;
  } catch {
    return url.startsWith("localhost") ? `http://${url}` : `https://${url}`;
  }
}

const DEFAULT_SEQUENTIAL_TYPING_BUDGET_MS = 30_000;

type SegmenterConstructor = new (
  locale?: string,
  options?: { granularity?: "grapheme" | "word" | "sentence" }
) => {
  segment(input: string): Iterable<unknown>;
};

function graphemeCount(text: string): number {
  const Segmenter = (Intl as typeof Intl & { Segmenter?: SegmenterConstructor }).Segmenter;
  if (Segmenter) {
    return Array.from(new Segmenter(undefined, { granularity: "grapheme" }).segment(text)).length;
  }
  return [...text].length;
}

function chooseTypingStrategy(
  text: string,
  delayMs: number,
  timeoutMs: number | undefined
): "sequential" | "fill" {
  const budget = Math.min(DEFAULT_SEQUENTIAL_TYPING_BUDGET_MS, timeoutMs ?? DEFAULT_SEQUENTIAL_TYPING_BUDGET_MS);
  return graphemeCount(text) * Math.max(0, delayMs) > budget ? "fill" : "sequential";
}

export class McpRuntime {
  private connection:
    | {
        session: Awaited<ReturnType<BrowserSessionFactory>>;
      }
    | undefined;
  private tabs: BrowserTab[] = [];
  private snapshotCache: SnapshotCacheEntry | undefined;
  private pendingFileUploadTarget: ClickTarget | undefined;
  private fileUploadPending = false;
  private readonly snapshotMode: SnapshotMode;
  private readonly assetManager: AssetManager;

  constructor(
    private readonly sessionFactory: BrowserSessionFactory = connectBrowserSession,
    options: { snapshotMode?: SnapshotMode } & AssetOptions = {}
  ) {
    this.snapshotMode = options.snapshotMode ?? "full";
    this.assetManager = new AssetManager(options);
  }

  getAssetManager(): AssetManager {
    return this.assetManager;
  }

  async connect(args: Parameters<BrowserSessionFactory>[0]): Promise<{
    browserName: string;
    protocol: string;
    version: string;
    tabs: BrowserTab[];
    snapshot?: BrowserSnapshot;
  }> {
    await this.close();
    const session = await this.sessionFactory({
      ...args,
      assetRoots: this.assetManager.roots
    });
    this.connection = {
      session
    };
    this.tabs = await session.listTabs();
    this.pendingFileUploadTarget = undefined;
    this.fileUploadPending = false;
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
      this.pendingFileUploadTarget = undefined;
      this.fileUploadPending = false;
    }
    return this.tabs;
  }

  async ensureActiveCursorVisualization(): Promise<void> {
    await this.requireConnected().ensureActiveCursorVisualization();
  }

  async newTab(url?: string): Promise<{ tabs: BrowserTab[]; snapshot?: BrowserSnapshot }> {
    const session = this.requireConnected();
    this.invalidateSnapshot();
    this.pendingFileUploadTarget = undefined;
    this.fileUploadPending = false;
    this.tabs = await session.newTab(url);
    if (this.snapshotMode === "none") {
      return {
        tabs: this.tabs
      };
    }
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
    this.pendingFileUploadTarget = undefined;
    this.fileUploadPending = false;
    this.tabs = await session.selectTab(tab.id);
    if (this.snapshotMode === "none") {
      return {
        tabs: this.tabs
      };
    }
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
    this.pendingFileUploadTarget = undefined;
    this.fileUploadPending = false;
    this.tabs = await session.closeTab(tab.id);
    if (this.snapshotMode === "none") {
      return {
        tabs: this.tabs
      };
    }
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
    const requestKey = this.snapshotRequestKey(args);
    const request: BrowserSnapshotRequest = {
      ...(args.boxes !== undefined ? { boxes: args.boxes } : {}),
      ...(args.depth !== undefined ? { depth: args.depth } : {}),
      ...(args.target ? { target: this.resolveSnapshotTarget(args.target) } : {})
    };
    const { activeTab, currentActiveTab, snapshot } = await this.captureStableSnapshot(session, request);
    this.snapshotCache = {
      tabId: currentActiveTab.id,
      requestKey,
      text: snapshot.text,
      refs: { ...snapshot.refs },
      title: currentActiveTab.title || snapshot.title,
      url: currentActiveTab.url || snapshot.url,
      ...(snapshot.console ? { console: { ...snapshot.console } } : {}),
      ...(snapshot.consoleLink ? { consoleLink: snapshot.consoleLink } : {})
    };
    return {
      ...snapshot,
      title: currentActiveTab.title || snapshot.title,
      url: currentActiveTab.url || snapshot.url
    };
  }

  private async captureStableSnapshot(
    session: ReturnType<McpRuntime["requireConnected"]>,
    request: BrowserSnapshotRequest
  ): Promise<{
    activeTab: BrowserTab;
    currentActiveTab: BrowserTab;
    snapshot: BrowserSnapshot;
  }> {
    let lastAttempt:
      | {
          activeTab: BrowserTab;
          currentActiveTab: BrowserTab;
          snapshot: BrowserSnapshot;
        }
      | undefined;

    for (let attempt = 0; attempt < 4; attempt += 1) {
      this.tabs = await session.listTabs();
      const activeTab = this.requireActiveTab();
      const snapshot = await session.snapshot(request);
      const refreshedTabs = await session.listTabs();
      this.tabs = refreshedTabs;
      const currentActiveTab =
        refreshedTabs.find((tab) => tab.active)
        ?? refreshedTabs.find((tab) => tab.id === activeTab.id)
        ?? activeTab;
      const captured = {
        activeTab,
        currentActiveTab,
        snapshot
      };
      lastAttempt = captured;

      if (!snapshot.retryable || snapshot.text.trim().length > 0 || currentActiveTab.url === "about:blank") {
        return captured;
      }

      await delay(150 * (attempt + 1));
    }

    if (!lastAttempt) {
      throw new McpToolError("action_failed", "Unable to capture page snapshot.");
    }

    return lastAttempt;
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
    const opensFileChooser = await session.isFileInput(resolved);
    const humanOpts = resolveHumanizationOptions(opts?.human as HumanizationOptions | undefined);

    if (opensFileChooser || session.consumePendingFileChooserTarget) {
      await session.prepareForFileUpload?.(resolved);
    }

    await session.hover(resolved);
    const hoverDelayMs = jitter(humanOpts.hoverBeforeClickMs);
    if (hoverDelayMs > 0) await delay(hoverDelayMs);

    await session.click(resolved, {
      ...(opts?.doubleClick !== undefined ? { doubleClick: opts.doubleClick } : {}),
      ...(opts?.button !== undefined ? { button: opts.button } : {}),
      ...(opts?.modifiers !== undefined ? { modifiers: opts.modifiers as SessionClickOptions["modifiers"] } : {}),
      clickHoldMs: jitter(humanOpts.clickHoldMs),
      moveDelayMs: Math.max(40, jitter(humanOpts.moveJitterMs))
    } as SessionClickOptions);

    this.invalidateSnapshot();
    let chooserTarget = await session.consumePendingFileChooserTarget?.({
      timeoutMs: Math.max(250, jitter(humanOpts.hoverBeforeClickMs + humanOpts.clickHoldMs))
    });
    chooserTarget ??= await session.consumePendingFileChooserTarget?.({ timeoutMs: 0 });
    this.pendingFileUploadTarget = chooserTarget ?? (opensFileChooser ? resolved : undefined);
    this.fileUploadPending = !!this.pendingFileUploadTarget;
    if (this.snapshotMode === "none") {
      return undefined;
    }
    if (await session.hasDialog()) {
      return undefined;
    }
    return this.snapshot();
  }

  async hover(target: string): Promise<BrowserSnapshot | undefined> {
    const session = this.requireConnected();
    const resolved = this.resolveTarget(target);
    const humanOpts = resolveHumanizationOptions();
    await session.hover(resolved, {
      moveDelayMs: Math.max(40, jitter(humanOpts.moveJitterMs))
    });
    this.invalidateSnapshot();
    this.pendingFileUploadTarget = undefined;
    this.fileUploadPending = false;
    if (this.snapshotMode === "none") {
      return undefined;
    }
    if (await session.hasDialog()) {
      return undefined;
    }
    return this.snapshot();
  }

  async navigate(url: string): Promise<BrowserSnapshot | undefined> {
    const session = this.requireConnected();
    await session.navigate(normalizeNavigationUrl(url));
    this.invalidateSnapshot();
    this.pendingFileUploadTarget = undefined;
    this.fileUploadPending = false;
    if (this.snapshotMode === "none") {
      return undefined;
    }
    if (await session.hasDialog()) {
      return undefined;
    }
    return this.snapshot();
  }

  async type(
    ref: string,
    text: string,
    opts?: {
      submit?: boolean;
      slowly?: boolean;
      timeout?: number;
      strategy?: "sequential" | "fill";
      human?: { profile?: string };
    }
  ): Promise<BrowserSnapshot | undefined> {
    const session = this.requireConnected();
    const resolved = this.resolveTarget(ref);
    const humanOpts = resolveHumanizationOptions(opts?.human as HumanizationOptions | undefined);
    const strategy =
      opts?.strategy
      ?? (opts?.slowly ? "sequential" : chooseTypingStrategy(text, humanOpts.typingDelayMs, opts?.timeout));
    await session.hover(resolved);
    const hoverDelayMs = jitter(humanOpts.hoverBeforeClickMs);
    if (hoverDelayMs > 0) {
      await delay(hoverDelayMs);
    }
    await session.click(resolved, {
      clickHoldMs: jitter(humanOpts.clickHoldMs),
      moveDelayMs: Math.max(40, jitter(humanOpts.moveJitterMs))
    });
    await session.focus(resolved);
    if (strategy === "fill") {
      await session.type(resolved, text, { strategy: "fill" });
      if (opts?.submit) {
        await session.pressKey("Enter");
      }
    } else {
      await session.clear(resolved);
      await session.type(resolved, text, {
        ...(opts?.submit !== undefined ? { submit: opts.submit } : {}),
        slowly: true,
        strategy: "sequential",
        delayMs: jitter(humanOpts.typingDelayMs),
        varianceMs: humanOpts.typingVarianceMs
      });
    }
    this.invalidateSnapshot();
    this.pendingFileUploadTarget = undefined;
    this.fileUploadPending = false;
    if (this.snapshotMode === "none") {
      return undefined;
    }
    return this.snapshot();
  }

  async pressKey(
    key: string,
    modifiers?: Array<"Alt" | "Control" | "ControlOrMeta" | "Meta" | "Shift">,
    human?: { profile?: string }
  ): Promise<BrowserSnapshot | undefined> {
    const session = this.requireConnected();
    const humanOpts = resolveHumanizationOptions(human as HumanizationOptions | undefined);
    const delayMs = jitter(humanOpts.typingDelayMs);
    if (delayMs > 0) await delay(delayMs);
    await session.pressKey(key, modifiers);
    this.invalidateSnapshot();
    this.pendingFileUploadTarget = undefined;
    this.fileUploadPending = false;
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
    this.pendingFileUploadTarget = undefined;
    this.fileUploadPending = false;
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
    this.pendingFileUploadTarget = undefined;
    this.fileUploadPending = false;
    if (this.snapshotMode === "none") {
      return undefined;
    }
    return this.snapshot();
  }

  async goBack(): Promise<BrowserSnapshot | undefined> {
    const session = this.requireConnected();
    await session.goBack();
    this.invalidateSnapshot();
    this.pendingFileUploadTarget = undefined;
    this.fileUploadPending = false;
    if (this.snapshotMode === "none") {
      return undefined;
    }
    return this.snapshot();
  }

  async goForward(): Promise<BrowserSnapshot | undefined> {
    const session = this.requireConnected();
    await session.goForward();
    this.invalidateSnapshot();
    this.pendingFileUploadTarget = undefined;
    this.fileUploadPending = false;
    if (this.snapshotMode === "none") {
      return undefined;
    }
    return this.snapshot();
  }

  async resize(width: number, height: number): Promise<BrowserSnapshot | undefined> {
    const session = this.requireConnected();
    await session.resize(width, height);
    this.invalidateSnapshot();
    this.pendingFileUploadTarget = undefined;
    this.fileUploadPending = false;
    if (this.snapshotMode === "none") {
      return undefined;
    }
    return this.snapshot();
  }

  async consoleMessages(level?: "error" | "warning" | "info" | "debug", all?: boolean): Promise<BrowserConsoleEntry[]> {
    const session = this.requireConnected();
    return session.consoleMessages(level, all);
  }

  async evaluate(expression: string, target?: string): Promise<unknown> {
    const session = this.requireConnected();
    const resolved = target ? this.resolveTarget(target) : undefined;
    return session.evaluate(expression, resolved);
  }

  async drag(startTarget: string, endTarget: string, human?: { profile?: string }): Promise<BrowserSnapshot | undefined> {
    const session = this.requireConnected();
    const humanOpts = resolveHumanizationOptions(human as HumanizationOptions | undefined);
    await session.drag(this.resolveTarget(startTarget), this.resolveTarget(endTarget), {
      moveDelayMs: Math.max(40, jitter(humanOpts.moveJitterMs)),
      holdDelayMs: jitter(humanOpts.clickHoldMs)
    });
    this.invalidateSnapshot();
    this.pendingFileUploadTarget = undefined;
    this.fileUploadPending = false;
    if (this.snapshotMode === "none") {
      return undefined;
    }
    return this.snapshot();
  }

  async drop(target: string, payload: { paths?: string[]; data?: Record<string, string> }): Promise<BrowserSnapshot | undefined> {
    const session = this.requireConnected();
    await session.drop(this.resolveTarget(target), payload);
    this.invalidateSnapshot();
    this.pendingFileUploadTarget = undefined;
    this.fileUploadPending = false;
    if (this.snapshotMode === "none") {
      return undefined;
    }
    return this.snapshot();
  }

  async scroll(
    ref: string | null,
    deltaX: number,
    deltaY: number,
    human?: { profile?: string }
  ): Promise<BrowserSnapshot | undefined> {
    const session = this.requireConnected();
    const resolved = ref !== null ? this.resolveTarget(ref) : null;
    const humanOpts = resolveHumanizationOptions(human as HumanizationOptions | undefined);
    await session.scroll(resolved, deltaX, deltaY, {
      stepPx: Math.max(1, humanOpts.scrollStepPx),
      stepDelayMs: Math.max(0, jitter(humanOpts.moveJitterMs))
    });
    this.invalidateSnapshot();
    this.pendingFileUploadTarget = undefined;
    this.fileUploadPending = false;
    if (this.snapshotMode === "none") {
      return undefined;
    }
    return this.snapshot();
  }

  async takeScreenshot(options?: { type?: "png" | "jpeg"; fullPage?: boolean; target?: string }): Promise<{ data: string; mimeType: "image/png" | "image/jpeg" }> {
    const session = this.requireConnected();
    return session.screenshot({
      ...(options?.type !== undefined ? { type: options.type } : {}),
      ...(options?.fullPage !== undefined ? { fullPage: options.fullPage } : {}),
      ...(options?.target !== undefined ? { target: this.resolveTarget(options.target) } : {})
    });
  }

  async performFileUpload(paths: string[] | undefined): Promise<void> {
    const session = this.requireConnected();
    if (!this.fileUploadPending && !this.pendingFileUploadTarget) {
      throw new McpToolError(
        "no_file_chooser",
        "No file chooser visible."
      );
    }
    const humanOpts = resolveHumanizationOptions();
    const target = this.pendingFileUploadTarget
      ?? await session.consumePendingFileChooserTarget?.({
        timeoutMs: Math.max(600, jitter(humanOpts.hoverBeforeClickMs + humanOpts.clickHoldMs) * 2)
      });
    if (!target) {
      this.fileUploadPending = false;
      throw new McpToolError(
        "no_file_chooser",
        "No file chooser visible."
      );
    }
    this.pendingFileUploadTarget = undefined;
    this.fileUploadPending = false;
    try {
      if (paths !== undefined) {
        await session.uploadFile(target, paths);
      }
    } finally {
      await session.finishFileUpload?.(target);
    }
    this.invalidateSnapshot();
  }

  async uploadFile(paths: string[]): Promise<BrowserSnapshot | undefined> {
    await this.performFileUpload(paths);
    this.invalidateSnapshot();
    if (this.snapshotMode === "none") {
      return undefined;
    }
    return this.snapshot();
  }

  async fillForm(fields: Array<{
    target: string;
    type: "textbox" | "checkbox" | "radio" | "combobox" | "slider";
    value: string;
  }>, human?: { profile?: string }): Promise<BrowserSnapshot | undefined> {
    const session = this.requireConnected();
    const humanOpts = resolveHumanizationOptions(human as HumanizationOptions | undefined);
    for (const field of fields) {
      const resolved = this.resolveTarget(field.target);
      if (field.type === "textbox") {
        await humanizedFieldActivation(session, resolved, humanOpts);
        const metadata = await session.formFieldMetadata?.(resolved).catch(() => undefined);
        if (isDirectValueFillMetadata(metadata)) {
          await session.fillForm([{
            target: resolved,
            type: "value",
            value: field.value
          }]);
          continue;
        }
        await session.focus(resolved);
        await session.clear(resolved);
        await session.type(resolved, field.value, {
          slowly: true,
          delayMs: jitter(humanOpts.typingDelayMs),
          varianceMs: humanOpts.typingVarianceMs
        });
        continue;
      }
      if (field.type === "checkbox" || field.type === "radio") {
        await humanizedFieldActivation(session, resolved, humanOpts);
        await session.check(resolved, field.value === "true");
        continue;
      }
      if (field.type === "combobox") {
        await humanizedFieldActivation(session, resolved, humanOpts);
        await session.fillForm([{
          target: resolved,
          type: field.type,
          value: field.value
        }]);
        continue;
      }
      if (field.type === "slider") {
        await humanizedFieldActivation(session, resolved, humanOpts);
      }
      await session.fillForm([{
        target: resolved,
        type: field.type,
        value: field.value
      }]);
    }
    this.invalidateSnapshot();
    this.pendingFileUploadTarget = undefined;
    if (this.snapshotMode === "none") {
      return undefined;
    }
    return this.snapshot();
  }

  async handleDialog(accept: boolean, promptText?: string): Promise<BrowserSnapshot | undefined> {
    const session = this.requireConnected();
    await session.handleDialog(accept, promptText);
    this.invalidateSnapshot();
    this.pendingFileUploadTarget = undefined;
    if (this.snapshotMode === "none") {
      return undefined;
    }
    return this.snapshot();
  }

  async networkRequests(): Promise<BrowserNetworkRequest[]> {
    const session = this.requireConnected();
    return session.networkRequests();
  }

  async beginRequestCollection(): Promise<unknown> {
    const session = this.requireConnected();
    return session.beginRequestCollection?.();
  }

  async endRequestCollection(state?: unknown): Promise<BrowserNetworkRequest[]> {
    const session = this.requireConnected();
    return session.endRequestCollection?.(state) ?? [];
  }

  async waitForPageTimeout(timeoutMs: number): Promise<void> {
    const session = this.requireConnected();
    await session.waitForPageTimeout?.(timeoutMs);
  }

  async waitForMainFrameLoad(timeoutMs: number): Promise<void> {
    const session = this.requireConnected();
    await session.waitForMainFrameLoad?.(timeoutMs);
  }

  async networkRequest(index: number): Promise<BrowserNetworkRequest | undefined> {
    const session = this.requireConnected();
    return session.networkRequest(index);
  }

  async fetchResponseBody(index: number): Promise<string | undefined> {
    const session = this.requireConnected();
    return session.fetchResponseBody(index);
  }

  async waitForRequestFinished(requestId: string, timeoutMs: number): Promise<void> {
    const session = this.requireConnected();
    await session.waitForRequestFinished?.(requestId, timeoutMs);
  }

  async waitForRequestResponse(requestId: string, timeoutMs: number): Promise<void> {
    const session = this.requireConnected();
    await session.waitForRequestResponse?.(requestId, timeoutMs);
  }

  async runCodeUnsafe(code: string): Promise<unknown> {
    const session = this.requireConnected();
    const result = await session.runCodeUnsafe(code);
    this.invalidateSnapshot();
    this.pendingFileUploadTarget = undefined;
    return result;
  }

  async waitFor(
    condition: { text?: string; textGone?: string; url?: string },
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
      if (condition.textGone && snap.text.includes(condition.textGone)) {
        if (Date.now() >= deadline) {
          throw new McpToolError(
            "timeout",
            `Timed out after ${timeoutMs}ms waiting for text "${condition.textGone}" to disappear.`
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

  hasPendingFileUploadTarget(): boolean {
    return this.fileUploadPending || !!this.pendingFileUploadTarget;
  }

  async hasDialog(): Promise<boolean> {
    if (!this.connection) {
      return false;
    }
    return this.connection.session.hasDialog();
  }

  async close(): Promise<void> {
    this.invalidateSnapshot();
    this.pendingFileUploadTarget = undefined;
    this.fileUploadPending = false;
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

  resolveTarget(target: string): ClickTarget {
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

function isDirectValueFillMetadata(metadata: { tagName: string; inputType?: string | undefined } | undefined): boolean {
  if (!metadata || metadata.tagName !== "input") {
    return false;
  }
  return new Set(["color", "date", "time", "datetime-local", "month", "range", "week"]).has(
    metadata.inputType ?? ""
  );
}

async function humanizedFieldActivation(
  session: ConnectedBrowserSession,
  target: ClickTarget,
  humanOpts: ReturnType<typeof resolveHumanizationOptions>
): Promise<void> {
  await session.hover(target, {
    moveDelayMs: Math.max(40, jitter(humanOpts.moveJitterMs))
  });
  const hoverDelayMs = jitter(humanOpts.hoverBeforeClickMs);
  if (hoverDelayMs > 0) {
    await delay(hoverDelayMs);
  }
  await session.click(target, {
    clickHoldMs: jitter(humanOpts.clickHoldMs),
    moveDelayMs: Math.max(40, jitter(humanOpts.moveJitterMs))
  });
}

export class McpRuntimeManager {
  private readonly runtimes = new Map<string, McpRuntime>();

  constructor(
    private readonly sessionFactory?: CreateRoxyBrowserMcpServerOptions["sessionFactory"],
    private readonly options: { snapshotMode?: SnapshotMode } & AssetOptions = {}
  ) {}

  getRuntime(sessionId = "default"): McpRuntime {
    const existing = this.runtimes.get(sessionId);
    if (existing) {
      return existing;
    }

    const runtime = new McpRuntime(this.sessionFactory, {
      ...(this.options.snapshotMode !== undefined ? { snapshotMode: this.options.snapshotMode } : {}),
      ...(this.options.artifactsDir !== undefined ? { artifactsDir: this.options.artifactsDir } : {}),
      ...(this.options.downloadsDir !== undefined ? { downloadsDir: this.options.downloadsDir } : {}),
      ...(this.options.screenshotsDir !== undefined ? { screenshotsDir: this.options.screenshotsDir } : {}),
      ...(this.options.snapshotsDir !== undefined ? { snapshotsDir: this.options.snapshotsDir } : {}),
      ...(this.options.tracesDir !== undefined ? { tracesDir: this.options.tracesDir } : {}),
      ...(this.options.videosDir !== undefined ? { videosDir: this.options.videosDir } : {}),
      ...(this.options.networkDir !== undefined ? { networkDir: this.options.networkDir } : {}),
      ...(this.options.consoleDir !== undefined ? { consoleDir: this.options.consoleDir } : {}),
      ...(this.options.scriptsDir !== undefined ? { scriptsDir: this.options.scriptsDir } : {}),
      ...(this.options.tempDir !== undefined ? { tempDir: this.options.tempDir } : {}),
      ...(this.options.allowAbsoluteAssetPaths !== undefined
        ? { allowAbsoluteAssetPaths: this.options.allowAbsoluteAssetPaths }
        : {})
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
