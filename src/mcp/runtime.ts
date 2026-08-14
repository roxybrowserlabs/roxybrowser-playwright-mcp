import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { connectBrowserSession } from "./connectedBrowser.js";
import { McpToolError } from "./errors.js";
import { AssetManager } from "../assets/manager.js";
import type {
  BrowserConsoleEntry,
  BrowserConsoleSummary,
  BrowserCookie,
  BrowserCookieFilter,
  BrowserCookieInput,
  BrowserEvaluateResult,
  BrowserNetworkRequest,
  BrowserNetworkResponseBody,
  BrowserSessionFactory,
  BrowserSnapshot,
  BrowserSnapshotRequest,
  BrowserSnapshotToolArgs,
  BrowserSnapshotTarget,
  BrowserStorageItem,
  BrowserStorageState,
  BrowserTab,
  ClickTarget,
  ConsoleMessageLevel,
  ConnectedBrowserSession,
  CreateRoxyBrowserMcpServerOptions,
  SessionClickOptions,
  SessionMouseClickOptions,
  SnapshotCacheEntry,
  SnapshotMode
} from "./types.js";
import type { BrowserContextOptions } from "../types/options.js";
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
const BLOCK_SERVICE_WORKERS_INIT_SCRIPT =
  "\nif (navigator.serviceWorker) navigator.serviceWorker.register = async () => { console.warn('Service Worker registration blocked by Playwright'); };\n";

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
  private readonly redactText: ((text: string) => string) | undefined;
  private readonly contextOptions: BrowserContextOptions | undefined;
  private readonly viewport: { width: number; height: number } | undefined;
  private readonly initScript: string[] | undefined;
  private readonly consoleLevel: ConsoleMessageLevel | undefined;
  private readonly network: CreateRoxyBrowserMcpServerOptions["network"] | undefined;
  private readonly testIdAttribute: string | undefined;
  private readonly storageOrigins = new Set<string>();
  private traceRecording:
    | {
        tracesDir: string;
        name: string;
        traceFile: string;
        networkFile: string;
        stacksFile: string;
        resourcesDir: string;
      }
    | undefined;

  constructor(
    private readonly sessionFactory: BrowserSessionFactory = connectBrowserSession,
    options: {
      snapshotMode?: SnapshotMode;
      redactText?: (text: string) => string;
      contextOptions?: BrowserContextOptions;
      viewport?: { width: number; height: number };
      initScript?: string[];
      consoleLevel?: ConsoleMessageLevel;
      network?: CreateRoxyBrowserMcpServerOptions["network"];
      testIdAttribute?: string;
    } & AssetOptions = {}
  ) {
    this.snapshotMode = options.snapshotMode ?? "full";
    this.assetManager = new AssetManager(options);
    this.redactText = options.redactText;
    this.contextOptions = options.contextOptions;
    this.viewport = options.viewport;
    this.initScript = options.initScript;
    this.consoleLevel = options.consoleLevel;
    this.network = options.network;
    this.testIdAttribute = options.testIdAttribute;
  }

  getAssetManager(): AssetManager {
    return this.assetManager;
  }

  async startTracing(): Promise<{ tracesDir: string; name: string; traceFile: string; networkFile: string; stacksFile: string; resourcesDir: string }> {
    if (this.traceRecording) {
      throw new Error("Tracing has been already started");
    }
    const name = `trace-${Date.now()}`;
    const tracesDir = path.join(this.assetManager.roots.tracesDir, "traces");
    const resourcesDir = path.join(tracesDir, "resources");
    const traceFile = path.join(tracesDir, `${name}.trace`);
    const networkFile = path.join(tracesDir, `${name}.network`);
    const stacksFile = path.join(tracesDir, `${name}.stacks`);
    await mkdir(resourcesDir, { recursive: true });
    await Promise.all([
      writeFile(traceFile, ""),
      writeFile(networkFile, ""),
      writeFile(stacksFile, "")
    ]);
    this.traceRecording = {
      tracesDir,
      name,
      traceFile,
      networkFile,
      stacksFile,
      resourcesDir
    };
    return this.traceRecording;
  }

  async stopTracing(): Promise<{ tracesDir: string; name: string; traceFile: string; networkFile: string; stacksFile: string; resourcesDir: string }> {
    const traceRecording = this.traceRecording;
    if (!traceRecording) {
      throw new Error("Tracing is not started");
    }
    this.traceRecording = undefined;
    return traceRecording;
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
      assetRoots: this.assetManager.roots,
      downloadsDir: this.assetManager.roots.downloadsDir,
      ...(this.redactText !== undefined ? { redactText: this.redactText } : {}),
      ...(this.consoleLevel !== undefined ? { consoleLevel: this.consoleLevel } : {}),
      ...(this.testIdAttribute !== undefined ? { testIdAttribute: this.testIdAttribute } : {})
    });
    this.connection = {
      session
    };
    this.tabs = await session.listTabs();
    this.recordStorageOrigins(this.tabs);
    await this.installNetworkOriginFilters(session);
    this.pendingFileUploadTarget = undefined;
    this.fileUploadPending = false;
    if (this.contextOptions) {
      await session.emulateContext?.(this.contextOptions);
      if (this.contextOptions.serviceWorkers === "block") {
        await session.addInitScript(BLOCK_SERVICE_WORKERS_INIT_SCRIPT);
      }
      if (this.contextOptions.storageState !== undefined) {
        await this.setStorageStateFromFile(session, this.contextOptions.storageState);
      }
      this.tabs = await session.listTabs();
    } else if (this.viewport) {
      await session.resize(this.viewport.width, this.viewport.height);
      this.tabs = await session.listTabs();
    }
    for (const initScript of this.initScript ?? []) {
      const source = await readFile(initScript, "utf8");
      await session.addInitScript(source);
    }
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

  private async setStorageStateFromFile(session: ConnectedBrowserSession, filename: string): Promise<void> {
    const state = JSON.parse(await readFile(filename, "utf8")) as BrowserStorageState;
    if (session.setStorageState) {
      await session.setStorageState(state);
      this.recordStorageOrigins(state.origins.map((originState) => ({ url: originState.origin })));
      return;
    }
    this.connection = { session };
    await this.setStorageState(state);
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
      ...(snapshot.locators ? { locators: { ...snapshot.locators } } : {}),
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

  async ariaSnapshot(args: BrowserSnapshotToolArgs = {}): Promise<string> {
    const session = this.requireConnected();
    const request: BrowserSnapshotRequest = {
      ...(args.boxes !== undefined ? { boxes: args.boxes } : {}),
      ...(args.depth !== undefined ? { depth: args.depth } : {}),
      ...(args.target ? { target: this.resolveSnapshotTarget(args.target) } : {})
    };
    return session.ariaSnapshot(request);
  }

  async countByRole(role: string, accessibleName: string): Promise<number> {
    return this.requireConnected().countByRole(role, accessibleName);
  }

  async textContentsByText(text: string, options: { target?: string | undefined; visible?: boolean | undefined } = {}): Promise<string[]> {
    const session = this.requireConnected();
    return session.textContentsByText(text, {
      ...(options.visible !== undefined ? { visible: options.visible } : {}),
      ...(options.target !== undefined ? { target: this.resolveTarget(options.target) } : {})
    });
  }

  async textContent(target: string): Promise<string | null> {
    return this.requireConnected().textContent(this.resolveTarget(target));
  }

  async inputValue(target: string): Promise<string> {
    return this.requireConnected().inputValue(this.resolveTarget(target));
  }

  async isChecked(target: string): Promise<boolean> {
    return this.requireConnected().isChecked(this.resolveTarget(target));
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
    const normalizedUrl = normalizeNavigationUrl(url);
    await session.navigate(normalizedUrl);
    this.recordStorageOrigin(normalizedUrl);
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

  async press(
    ref: string,
    key: string,
    human?: { profile?: string }
  ): Promise<BrowserSnapshot | undefined> {
    const session = this.requireConnected();
    const resolved = this.resolveTarget(ref);
    const humanOpts = resolveHumanizationOptions(human as HumanizationOptions | undefined);
    const delayMs = jitter(humanOpts.typingDelayMs);
    if (delayMs > 0) await delay(delayMs);
    await session.press(resolved, key);
    this.invalidateSnapshot();
    this.pendingFileUploadTarget = undefined;
    this.fileUploadPending = false;
    if (this.snapshotMode === "none") {
      return undefined;
    }
    return this.snapshot();
  }

  async pressSequentially(
    text: string,
    opts?: { submit?: boolean; human?: HumanizationOptions }
  ): Promise<BrowserSnapshot | undefined> {
    const session = this.requireConnected();
    const humanOpts = resolveHumanizationOptions(opts?.human);
    const delayMs = jitter(humanOpts.typingDelayMs);
    if (delayMs > 0) await delay(delayMs);
    await session.typeKeyboard(text);
    if (opts?.submit) {
      await session.pressKey("Enter");
    }
    this.invalidateSnapshot();
    this.pendingFileUploadTarget = undefined;
    this.fileUploadPending = false;
    if (this.snapshotMode === "none") {
      return undefined;
    }
    return this.snapshot();
  }

  async keyDown(key: string): Promise<void> {
    const session = this.requireConnected();
    await session.keyDown(key);
  }

  async keyUp(key: string): Promise<void> {
    const session = this.requireConnected();
    await session.keyUp(key);
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

  async reload(): Promise<BrowserSnapshot | undefined> {
    const session = this.requireConnected();
    await session.reload();
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

  async consoleMessageSummary(): Promise<BrowserConsoleSummary> {
    const session = this.requireConnected();
    return session.consoleMessageSummary();
  }

  async clearConsoleMessages(): Promise<void> {
    const session = this.requireConnected();
    await session.clearConsoleMessages();
  }

  async evaluate(expression: string, target?: string): Promise<BrowserEvaluateResult> {
    const session = this.requireConnected();
    const resolved = target ? this.resolveTarget(target) : undefined;
    return session.evaluate(expression, resolved);
  }

  async setContent(html: string): Promise<void> {
    const session = this.requireConnected();
    await session.setContent(html);
    this.invalidateSnapshot();
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

  async mouseMove(x: number, y: number, human?: { profile?: string }): Promise<void> {
    const session = this.requireConnected();
    const humanOpts = resolveHumanizationOptions(human as HumanizationOptions | undefined);
    await session.mouseMove(x, y, {
      moveDelayMs: Math.max(40, jitter(humanOpts.moveJitterMs))
    });
    this.invalidateSnapshot();
    this.pendingFileUploadTarget = undefined;
    this.fileUploadPending = false;
  }

  async mouseClick(
    x: number,
    y: number,
    options?: {
      button?: "left" | "right" | "middle";
      clickCount?: number;
      delay?: number;
      human?: { profile?: string };
    }
  ): Promise<BrowserSnapshot | undefined> {
    const session = this.requireConnected();
    const humanOpts = resolveHumanizationOptions(options?.human as HumanizationOptions | undefined);
    const clickOptions: SessionMouseClickOptions = {
      ...(options?.button !== undefined ? { button: options.button } : {}),
      ...(options?.clickCount !== undefined ? { clickCount: options.clickCount } : {}),
      ...(options?.delay !== undefined ? { delay: options.delay } : {}),
      moveDelayMs: Math.max(40, jitter(humanOpts.moveJitterMs))
    };
    await session.mouseClick(x, y, clickOptions);
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

  async mouseDrag(
    startX: number,
    startY: number,
    endX: number,
    endY: number,
    human?: { profile?: string }
  ): Promise<BrowserSnapshot | undefined> {
    const session = this.requireConnected();
    const humanOpts = resolveHumanizationOptions(human as HumanizationOptions | undefined);
    await session.mouseDrag(startX, startY, endX, endY, {
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

  async takeScreenshot(options?: { type?: "png" | "jpeg" | "webp"; quality?: number; fullPage?: boolean; scale?: "css" | "device"; target?: string }): Promise<{ data: string; mimeType: "image/png" | "image/jpeg" | "image/webp" }> {
    const session = this.requireConnected();
    return session.screenshot({
      ...(options?.type !== undefined ? { type: options.type } : {}),
      ...(options?.quality !== undefined ? { quality: options.quality } : {}),
      ...(options?.fullPage !== undefined ? { fullPage: options.fullPage } : {}),
      ...(options?.scale !== undefined ? { scale: options.scale } : {}),
      ...(options?.target !== undefined ? { target: this.resolveTarget(options.target) } : {})
    });
  }

  async pdf(): Promise<Buffer> {
    const session = this.requireConnected();
    return session.pdf();
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

  async clearRequests(): Promise<void> {
    const session = this.requireConnected();
    await session.clearRequests();
  }

  async setOffline(offline: boolean): Promise<void> {
    const session = this.requireConnected();
    if (!session.setOffline) {
      throw new McpToolError("not_supported", "Network state emulation is not supported by this browser session.");
    }
    await session.setOffline(offline);
  }

  async addRoute(route: import("./types.js").BrowserNetworkRoute): Promise<void> {
    const session = this.requireConnected();
    if (!session.addRoute) {
      throw new McpToolError("not_supported", "Network request routing is not supported by this browser session.");
    }
    await session.addRoute(route);
  }

  private async installNetworkOriginFilters(session: ConnectedBrowserSession): Promise<void> {
    const allowedOrigins = this.network?.allowedOrigins ?? [];
    const blockedOrigins = this.network?.blockedOrigins ?? [];
    if (!allowedOrigins.length && !blockedOrigins.length) {
      return;
    }
    if (!session.addRoute) {
      throw new McpToolError("not_supported", "Network request routing is not supported by this browser session.");
    }
    if (allowedOrigins.length) {
      await session.addRoute({
        pattern: "**",
        abort: "blockedbyclient"
      });
      for (const origin of allowedOrigins) {
        await session.addRoute({
          pattern: originOrHostGlob(origin)
        });
      }
    }
    for (const origin of blockedOrigins) {
      await session.addRoute({
        pattern: originOrHostGlob(origin),
        abort: "blockedbyclient"
      });
    }
  }

  async routes(): Promise<import("./types.js").BrowserNetworkRoute[]> {
    const session = this.requireConnected();
    if (!session.routes) {
      throw new McpToolError("not_supported", "Network request routing is not supported by this browser session.");
    }
    return session.routes();
  }

  async removeRoute(pattern?: string): Promise<number> {
    const session = this.requireConnected();
    if (!session.removeRoute) {
      throw new McpToolError("not_supported", "Network request routing is not supported by this browser session.");
    }
    return session.removeRoute(pattern);
  }

  async cookies(): Promise<BrowserCookie[]> {
    const session = this.requireConnected();
    if (!session.cookies) {
      throw new McpToolError("not_supported", "Browser context cookies are not supported by this browser session.");
    }
    return session.cookies();
  }

  async storageState(): Promise<BrowserStorageState> {
    const session = this.requireConnected();
    if (session.storageState) {
      return session.storageState();
    }
    if (!session.cookies) {
      throw new McpToolError("not_supported", "Browser context storage state is not supported by this browser session.");
    }

    const cookies = await session.cookies();
    const origins = session.webStorageItems
      ? await this.collectLocalStorageOrigins(session)
      : [];
    return { cookies, origins };
  }

  async setStorageState(state: BrowserStorageState): Promise<void> {
    const session = this.requireConnected();
    if (session.setStorageState) {
      await session.setStorageState(state);
      this.recordStorageOrigins(state.origins.map((originState) => ({ url: originState.origin })));
      return;
    }
    if (!session.clearCookies || !session.addCookies) {
      throw new McpToolError("not_supported", "Browser context storage state is not supported by this browser session.");
    }

    await session.clearCookies();
    if (state.cookies.length) {
      await session.addCookies(state.cookies);
    }

    if (!session.clearWebStorage || !session.setWebStorageItem) {
      return;
    }

    const originsToReset = new Set([
      ...this.storageOrigins,
      ...state.origins.map((originState) => originState.origin)
    ]);
    await this.withStorageOrigins(session, originsToReset, async (origin) => {
      await session.clearWebStorage!("localStorage");
      const originState = state.origins.find((candidate) => candidate.origin === origin);
      for (const item of originState?.localStorage ?? []) {
        await session.setWebStorageItem!("localStorage", item.name, item.value);
      }
    });
    this.storageOrigins.clear();
    this.recordStorageOrigins(state.origins.map((originState) => ({ url: originState.origin })));
  }

  async addCookies(cookies: ReadonlyArray<BrowserCookieInput>): Promise<void> {
    const session = this.requireConnected();
    if (!session.addCookies) {
      throw new McpToolError("not_supported", "Browser context cookies are not supported by this browser session.");
    }
    await session.addCookies(cookies);
  }

  async clearCookies(options?: BrowserCookieFilter): Promise<void> {
    const session = this.requireConnected();
    if (!session.clearCookies) {
      throw new McpToolError("not_supported", "Browser context cookies are not supported by this browser session.");
    }
    await session.clearCookies(options);
  }

  async webStorageItems(storageName: "localStorage" | "sessionStorage"): Promise<BrowserStorageItem[]> {
    const session = this.requireConnected();
    if (!session.webStorageItems) {
      throw new McpToolError("not_supported", "Web storage is not supported by this browser session.");
    }
    return session.webStorageItems(storageName);
  }

  async setWebStorageItem(storageName: "localStorage" | "sessionStorage", key: string, value: string): Promise<void> {
    const session = this.requireConnected();
    if (!session.setWebStorageItem) {
      throw new McpToolError("not_supported", "Web storage is not supported by this browser session.");
    }
    await session.setWebStorageItem(storageName, key, value);
    if (storageName === "localStorage") {
      this.recordStorageOrigins(await session.listTabs());
    }
  }

  async removeWebStorageItem(storageName: "localStorage" | "sessionStorage", key: string): Promise<void> {
    const session = this.requireConnected();
    if (!session.removeWebStorageItem) {
      throw new McpToolError("not_supported", "Web storage is not supported by this browser session.");
    }
    await session.removeWebStorageItem(storageName, key);
  }

  async clearWebStorage(storageName: "localStorage" | "sessionStorage"): Promise<void> {
    const session = this.requireConnected();
    if (!session.clearWebStorage) {
      throw new McpToolError("not_supported", "Web storage is not supported by this browser session.");
    }
    await session.clearWebStorage(storageName);
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

  async fetchResponseBody(index: number): Promise<BrowserNetworkResponseBody | undefined> {
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
    this.storageOrigins.clear();
    this.traceRecording = undefined;
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
        "No RoxyBrowser browser is connected. Connect to an existing RoxyBrowser browser or launch one from RoxyBrowser first."
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

  resolveLocatorForCode(target: string): string | undefined {
    const activeTab = this.requireActiveTab();
    if (!/^(f\d+)?e\d+$/.test(target)) {
      return undefined;
    }
    if (!this.snapshotCache || this.snapshotCache.tabId !== activeTab.id) {
      return undefined;
    }
    return this.snapshotCache.locators?.[target];
  }

  private async collectLocalStorageOrigins(session: ConnectedBrowserSession): Promise<BrowserStorageState["origins"]> {
    this.recordStorageOrigins(await session.listTabs());
    const origins = new Set(this.storageOrigins);
    if (!origins.size) {
      return [];
    }

    const result: BrowserStorageState["origins"] = [];
    await this.withStorageOrigins(session, origins, async (origin) => {
      const localStorage = await session.webStorageItems!("localStorage");
      if (localStorage.length) {
        result.push({ origin, localStorage });
      }
    });
    return result;
  }

  private async withStorageOrigins(
    session: ConnectedBrowserSession,
    origins: Iterable<string>,
    callback: (origin: string) => Promise<void>
  ): Promise<void> {
    // ⚠️ DIVERGENCE FROM PLAYWRIGHT: Playwright collects/restores storage in a
    // hidden storage-state page. The MCP session adapter currently exposes
    // only real tab operations, so the fallback uses short-lived visible tabs
    // for non-active origins while preserving the caller's active tab.
    const originalTabs = await session.listTabs();
    this.tabs = originalTabs;
    const originalTab = originalTabs.find((tab) => tab.active);
    const originalOrigin = originalTab ? storageOriginFromUrl(originalTab.url) : undefined;

    for (const origin of origins) {
      if (origin === originalOrigin) {
        await callback(origin);
        continue;
      }

      const beforeTabs = await session.listTabs();
      await session.newTab(origin);
      const afterTabs = await session.listTabs();
      const temporaryTab = afterTabs.find((tab) => tab.active && !beforeTabs.some((before) => before.id === tab.id))
        ?? afterTabs.find((tab) => tab.active);
      try {
        await callback(origin);
      } finally {
        if (temporaryTab) {
          await session.closeTab(temporaryTab.id).catch(() => {});
        }
        if (originalTab) {
          await session.selectTab(originalTab.id).catch(() => {});
        }
        this.tabs = await session.listTabs().catch(() => this.tabs);
      }
    }
  }

  private recordStorageOrigins(tabs: ReadonlyArray<Pick<BrowserTab, "url">>): void {
    for (const tab of tabs) {
      this.recordStorageOrigin(tab.url);
    }
  }

  private recordStorageOrigin(url: string): void {
    const origin = storageOriginFromUrl(url);
    if (origin) {
      this.storageOrigins.add(origin);
    }
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

function storageOriginFromUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    return parsed.origin;
  } catch {
    return undefined;
  }
}

function originOrHostGlob(originOrHost: string): string {
  const wildcardPortMatch = /^(https?:\/\/[^/:]+):\*$/.exec(originOrHost);
  if (wildcardPortMatch) {
    return `${wildcardPortMatch[1]}:*/**`;
  }

  try {
    const url = new URL(originOrHost);
    if (url.origin !== "null") {
      return `${url.origin}/**`;
    }
  } catch {
    // Fall through to Playwright's legacy host-only mode.
  }
  return `*://${originOrHost}/**`;
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
    private readonly options: {
      snapshotMode?: SnapshotMode;
      redactText?: (text: string) => string;
      contextOptions?: BrowserContextOptions;
      viewport?: { width: number; height: number };
      initScript?: string[];
      consoleLevel?: ConsoleMessageLevel;
      network?: CreateRoxyBrowserMcpServerOptions["network"];
      testIdAttribute?: string;
    } & AssetOptions = {}
  ) {}

  getRuntime(sessionId = "default"): McpRuntime {
    const existing = this.runtimes.get(sessionId);
    if (existing) {
      return existing;
    }

    const runtime = new McpRuntime(this.sessionFactory, {
      ...(this.options.snapshotMode !== undefined ? { snapshotMode: this.options.snapshotMode } : {}),
      ...(this.options.redactText !== undefined ? { redactText: this.options.redactText } : {}),
      ...(this.options.contextOptions !== undefined ? { contextOptions: this.options.contextOptions } : {}),
      ...(this.options.viewport !== undefined ? { viewport: this.options.viewport } : {}),
      ...(this.options.initScript !== undefined ? { initScript: this.options.initScript } : {}),
      ...(this.options.consoleLevel !== undefined ? { consoleLevel: this.options.consoleLevel } : {}),
      ...(this.options.network !== undefined ? { network: this.options.network } : {}),
      ...(this.options.testIdAttribute !== undefined ? { testIdAttribute: this.options.testIdAttribute } : {}),
      ...(this.options.artifactsDir !== undefined ? { artifactsDir: this.options.artifactsDir } : {}),
      ...(this.options.downloadsDir !== undefined ? { downloadsDir: this.options.downloadsDir } : {}),
      ...(this.options.screenshotsDir !== undefined ? { screenshotsDir: this.options.screenshotsDir } : {}),
      ...(this.options.snapshotsDir !== undefined ? { snapshotsDir: this.options.snapshotsDir } : {}),
      ...(this.options.tracesDir !== undefined ? { tracesDir: this.options.tracesDir } : {}),
      ...(this.options.videosDir !== undefined ? { videosDir: this.options.videosDir } : {}),
      ...(this.options.networkDir !== undefined ? { networkDir: this.options.networkDir } : {}),
      ...(this.options.consoleDir !== undefined ? { consoleDir: this.options.consoleDir } : {}),
      ...(this.options.storageDir !== undefined ? { storageDir: this.options.storageDir } : {}),
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
