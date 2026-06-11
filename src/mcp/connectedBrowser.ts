import * as cdpModule from "chrome-remote-interface";
import {
  ARIA_SNAPSHOT_EVALUATE_SOURCE,
  normalizeAriaSnapshotOptions,
  type AriaSnapshotResult
} from "../ariaSnapshot.js";
import type { BidiProtocolClient } from "../protocol/bidi/client.js";
import { getBidiClientFactory } from "../protocol/bidi/client.js";
import { McpToolError } from "./errors.js";
import { ACTION_POINT_EVALUATE_SOURCE, ACTION_POINT_BY_SELECTOR_SOURCE } from "./snapshot.js";
import type {
  BrowserSnapshot,
  BrowserSnapshotRequest,
  BrowserTab,
  ClickTarget,
  ConnectedBrowserSession,
  RoxyBrowserConnectArgs,
  SessionClickOptions
} from "./types.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const chromeRemoteInterface = ("default" in cdpModule
  ? cdpModule.default
  : cdpModule) as unknown as {
  Version(options: { host: string; port: number }): Promise<{ Browser: string; webSocketDebuggerUrl: string }>;
  (options: {
    host?: string;
    port?: number;
    target?: string;
    local?: boolean;
  }): Promise<CdpClient>;
};

type CdpTargetInfo = {
  targetId: string;
  type: string;
  title: string;
  url: string;
};

type CdpClient = {
  close(): Promise<void>;
  Page: {
    enable(): Promise<void>;
  };
  Runtime: {
    enable(): Promise<void>;
    evaluate(options: {
      expression: string;
      returnByValue: true;
      awaitPromise: true;
    }): Promise<{ result: { value?: unknown }; exceptionDetails?: { text?: string } }>;
  };
  DOM: {
    enable(options: {}): Promise<void>;
  };
  Input: {
    dispatchMouseEvent(options: {
      type: "mouseMoved" | "mousePressed" | "mouseReleased";
      x: number;
      y: number;
      button: "none" | "left" | "middle" | "right";
      clickCount?: number;
      modifiers?: number;
    }): Promise<void>;
  };
  Target: {
    getTargets(): Promise<{ targetInfos: CdpTargetInfo[] }>;
    createTarget(options: { url: string }): Promise<{ targetId: string }>;
    activateTarget(options: { targetId: string }): Promise<void>;
    closeTarget(options: { targetId: string }): Promise<void>;
  };
};

interface CdpConnectionDetails {
  browserWsEndpoint: string;
  host: string;
  port: number;
}

function buildConnectionFromWsEndpoint(browserWsEndpoint: string): CdpConnectionDetails {
  const parsed = new URL(browserWsEndpoint);
  return {
    browserWsEndpoint,
    host: parsed.hostname,
    port: Number(parsed.port)
  };
}

async function resolveCdpConnection(endpoint: string): Promise<CdpConnectionDetails> {
  const parsed = new URL(endpoint);
  if (parsed.protocol === "ws:" || parsed.protocol === "wss:") {
    return buildConnectionFromWsEndpoint(endpoint);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new McpToolError(
      "unsupported_protocol_input",
      `CDP endpoint must use http(s) discovery or ws(s) browser websocket. Received "${parsed.protocol}".`
    );
  }

  const versionUrl = parsed.pathname.endsWith("/json/version")
    ? parsed
    : new URL("/json/version", parsed);
  const response = await fetch(versionUrl);
  if (!response.ok) {
    throw new Error(`Unable to resolve CDP discovery endpoint: ${response.status} ${response.statusText}`);
  }

  const payload = (await response.json()) as { webSocketDebuggerUrl?: string };
  if (!payload.webSocketDebuggerUrl) {
    throw new Error("CDP discovery response did not include webSocketDebuggerUrl.");
  }

  return buildConnectionFromWsEndpoint(payload.webSocketDebuggerUrl);
}

async function evaluateCdp<TResult>(
  client: CdpClient,
  functionSource: string,
  arg?: unknown
): Promise<TResult> {
  const expression =
    arg === undefined
      ? `(${functionSource})()`
      : `(${functionSource})(${JSON.stringify(arg)})`;
  const response = await client.Runtime.evaluate({
    expression,
    returnByValue: true,
    awaitPromise: true
  });

  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.text || "CDP runtime evaluation failed.");
  }

  return response.result.value as TResult;
}

async function evaluateBiDi<TResult>(
  client: BidiProtocolClient,
  contextId: string,
  functionSource: string,
  arg?: unknown
): Promise<TResult> {
  const expression =
    arg === undefined
      ? `(${functionSource})()`
      : `(${functionSource})(${JSON.stringify(arg)})`;
  const response = (await client.scriptEvaluate({
    expression,
    target: {
      context: contextId
    },
    awaitPromise: true,
    resultOwnership: "none"
  })) as {
    type: string;
    result?: { value?: TResult };
    exceptionDetails?: { text?: string };
  };

  if (response.type === "exception") {
    throw new Error(response.exceptionDetails?.text || "BiDi runtime evaluation failed.");
  }

  return response.result?.value as TResult;
}

function toAriaSnapshotPayload(request: BrowserSnapshotRequest = {}): {
  options: ReturnType<typeof normalizeAriaSnapshotOptions>;
  target?: BrowserSnapshotRequest["target"];
} {
  return {
    options: normalizeAriaSnapshotOptions({
      mode: "ai",
      ...(request.depth !== undefined ? { depth: request.depth } : {}),
      ...(request.boxes !== undefined ? { boxes: request.boxes } : {})
    }),
    ...(request.target ? { target: request.target } : {})
  };
}

function toBrowserSnapshot(
  result: AriaSnapshotResult,
  request: BrowserSnapshotRequest
): BrowserSnapshot {
  if (result.error) {
    const targetLabel = request.target?.raw ?? "target";
    const detailedMessage = result.error.message;
    if (result.error.code === "stale") {
      throw new McpToolError(
        "stale_ref",
        detailedMessage || `Target "${targetLabel}" is no longer valid. Call "browser_snapshot" again.`
      );
    }

    if (result.error.code === "invalid_selector" || result.error.code === "strict") {
      throw new McpToolError(
        "invalid_target",
        detailedMessage || `Target "${targetLabel}" is not a valid selector.`
      );
    }

    throw new McpToolError(
      "invalid_target",
      detailedMessage || `Target "${targetLabel}" could not be found in the active tab.`
    );
  }

  return {
    refs: result.refs,
    text: result.text,
    title: result.title,
    url: result.url
  };
}

function chooseInitialTab(tabs: Array<{ id: string; url: string }>): string | undefined {
  return tabs.find((tab) => tab.url && tab.url !== "about:blank")?.id ?? tabs[0]?.id;
}

class CdpConnectedBrowserSession implements ConnectedBrowserSession {
  readonly protocol = "cdp" as const;
  readonly browserName = "chromium" as const;

  private readonly pageClients = new Map<string, CdpClient>();
  private activeTabId: string | undefined;
  private versionString = "Chromium/unknown";

  private constructor(
    private readonly browserClient: CdpClient,
    private readonly connection: CdpConnectionDetails
  ) {}

  static async connect(args: RoxyBrowserConnectArgs): Promise<CdpConnectedBrowserSession> {
    if (args.browser && args.browser !== "chromium") {
      throw new McpToolError(
        "unsupported_protocol_input",
        'CDP attach only supports browser "chromium".'
      );
    }

    const connection = await resolveCdpConnection(args.endpoint);
    const version = await chromeRemoteInterface.Version({
      host: connection.host,
      port: connection.port
    });
    const browserClient = await chromeRemoteInterface({
      target: connection.browserWsEndpoint
    });

    const session = new CdpConnectedBrowserSession(browserClient, connection);
    session.versionString = version.Browser;
    const tabs = await session.refreshTabs();
    if (tabs.length === 0) {
      await session.newTab();
    }
    return session;
  }

  async version(): Promise<string> {
    return this.versionString;
  }

  async listTabs(): Promise<BrowserTab[]> {
    return this.refreshTabs();
  }

  async newTab(url = "about:blank"): Promise<BrowserTab[]> {
    const response = await this.browserClient.Target.createTarget({ url });
    this.activeTabId = response.targetId;
    await this.browserClient.Target.activateTarget({
      targetId: response.targetId
    });
    return this.refreshTabs();
  }

  async selectTab(tabId: string): Promise<BrowserTab[]> {
    this.activeTabId = tabId;
    await this.browserClient.Target.activateTarget({
      targetId: tabId
    });
    return this.refreshTabs();
  }

  async closeTab(tabId: string): Promise<BrowserTab[]> {
    const tabsBeforeClose = await this.refreshTabs();
    const index = tabsBeforeClose.findIndex((tab) => tab.id === tabId);
    await this.browserClient.Target.closeTarget({
      targetId: tabId
    });

    const pageClient = this.pageClients.get(tabId);
    if (pageClient) {
      this.pageClients.delete(tabId);
      await pageClient.close().catch(() => {});
    }

    const tabsAfterClose = await this.refreshTabs();
    if (tabsAfterClose.length === 0) {
      this.activeTabId = undefined;
      return tabsAfterClose;
    }

    const fallbackIndex = index >= 0 ? Math.min(index, tabsAfterClose.length - 1) : 0;
    this.activeTabId = tabsAfterClose[fallbackIndex]?.id;
    if (this.activeTabId) {
      await this.browserClient.Target.activateTarget({
        targetId: this.activeTabId
      });
    }
    return this.refreshTabs();
  }

  async snapshot(request: BrowserSnapshotRequest = {}): Promise<BrowserSnapshot> {
    const pageClient = await this.getActivePageClient();
    const result = await evaluateCdp<AriaSnapshotResult>(
      pageClient,
      ARIA_SNAPSHOT_EVALUATE_SOURCE,
      toAriaSnapshotPayload(request)
    );
    return toBrowserSnapshot(result, request);
  }

  async click(target: ClickTarget, options: SessionClickOptions): Promise<void> {
    const pageClient = await this.getActivePageClient();
    const source = "nodeToken" in target ? ACTION_POINT_EVALUATE_SOURCE : ACTION_POINT_BY_SELECTOR_SOURCE;
    const arg = "nodeToken" in target ? { nodeToken: target.nodeToken } : { selector: target.selector };
    const point = await evaluateCdp<{ ok: boolean; reason?: string; x?: number; y?: number }>(
      pageClient,
      source,
      arg
    );
    if (!point.ok || point.x === undefined || point.y === undefined) {
      const isSelector = "selector" in target;
      throw new McpToolError(
        isSelector ? "invalid_target" : "stale_ref",
        isSelector
          ? `Element "${target.selector}" could not be found or is not visible.`
          : 'The referenced element is no longer valid. Call "browser_snapshot" again.'
      );
    }

    const MODIFIER_BITS: Record<string, number> = {
      Alt: 1, Control: 2, ControlOrMeta: 2, Meta: 4, Shift: 8
    };
    const modifiersMask = (options.modifiers ?? []).reduce(
      (acc, m) => acc | (MODIFIER_BITS[m] ?? 0), 0
    );
    const cdpButton = (options.button ?? "left") as "left" | "middle" | "right";
    const clickCount = options.doubleClick ? 2 : 1;
    const cycles = options.doubleClick ? 2 : 1;

    await pageClient.Input.dispatchMouseEvent({
      type: "mouseMoved",
      x: point.x,
      y: point.y,
      button: "none",
      modifiers: modifiersMask
    });

    for (let i = 0; i < cycles; i++) {
      await pageClient.Input.dispatchMouseEvent({
        type: "mousePressed",
        x: point.x,
        y: point.y,
        button: cdpButton,
        clickCount,
        modifiers: modifiersMask
      });
      await delay(options.clickHoldMs);
      await pageClient.Input.dispatchMouseEvent({
        type: "mouseReleased",
        x: point.x,
        y: point.y,
        button: cdpButton,
        clickCount,
        modifiers: modifiersMask
      });
    }
  }

  async hover(target: ClickTarget): Promise<void> {
    const pageClient = await this.getActivePageClient();
    const source = "nodeToken" in target ? ACTION_POINT_EVALUATE_SOURCE : ACTION_POINT_BY_SELECTOR_SOURCE;
    const arg = "nodeToken" in target ? { nodeToken: target.nodeToken } : { selector: target.selector };
    const point = await evaluateCdp<{ ok: boolean; reason?: string; x?: number; y?: number }>(
      pageClient,
      source,
      arg
    );
    if (!point.ok || point.x === undefined || point.y === undefined) {
      const isSelector = "selector" in target;
      throw new McpToolError(
        isSelector ? "invalid_target" : "stale_ref",
        isSelector
          ? `Element "${target.selector}" could not be found or is not visible.`
          : 'The referenced element is no longer valid. Call "browser_snapshot" again.'
      );
    }

    await pageClient.Input.dispatchMouseEvent({
      type: "mouseMoved",
      x: point.x,
      y: point.y,
      button: "none"
    });
  }

  async close(): Promise<void> {
    await Promise.all(
      Array.from(this.pageClients.values()).map(async (client) => {
        await client.close().catch(() => {});
      })
    );
    this.pageClients.clear();
    await this.browserClient.close().catch(() => {});
  }

  private async refreshTabs(): Promise<BrowserTab[]> {
    const response = await this.browserClient.Target.getTargets();
    const tabs = response.targetInfos
      .filter((targetInfo) => {
        return targetInfo.type === "page" && !targetInfo.url.startsWith("devtools://");
      })
      .map((targetInfo) => ({
        id: targetInfo.targetId,
        title: targetInfo.title,
        url: targetInfo.url
      }));

    if (!this.activeTabId) {
      this.activeTabId = chooseInitialTab(tabs);
    }

    return tabs.map((tab) => ({
      ...tab,
      active: tab.id === this.activeTabId
    }));
  }

  private async getActivePageClient(): Promise<CdpClient> {
    const tabs = await this.refreshTabs();
    const activeTab = tabs.find((tab) => tab.active);
    if (!activeTab) {
      throw new McpToolError("no_active_tab", "No active tab is available.");
    }

    const existing = this.pageClients.get(activeTab.id);
    if (existing) {
      return existing;
    }

    const client = await chromeRemoteInterface({
      host: this.connection.host,
      port: this.connection.port,
      target: activeTab.id
    });
    await Promise.all([client.Page.enable(), client.Runtime.enable(), client.DOM.enable({})]);
    this.pageClients.set(activeTab.id, client);
    return client;
  }
}

class BidiConnectedBrowserSession implements ConnectedBrowserSession {
  readonly protocol = "bidi" as const;
  readonly browserName = "firefox" as const;

  private activeTabId: string | undefined;

  private constructor(private readonly client: BidiProtocolClient) {}

  static async connect(args: RoxyBrowserConnectArgs): Promise<BidiConnectedBrowserSession> {
    if (args.browser && args.browser !== "firefox") {
      throw new McpToolError(
        "unsupported_protocol_input",
        'BiDi attach only supports browser "firefox" in v1.'
      );
    }

    const parsed = new URL(args.endpoint);
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
      throw new McpToolError(
        "unsupported_protocol_input",
        `BiDi endpoint must be a ws(s) URL. Received "${parsed.protocol}".`
      );
    }

    const client = await getBidiClientFactory()({
      browserName: "firefox",
      webSocketUrl: args.endpoint
    });

    const session = new BidiConnectedBrowserSession(client);
    const tabs = await session.refreshTabs();
    if (tabs.length === 0) {
      await session.newTab();
    }
    return session;
  }

  async version(): Promise<string> {
    return `${this.browserName}/unknown`;
  }

  async listTabs(): Promise<BrowserTab[]> {
    return this.refreshTabs();
  }

  async newTab(url = "about:blank"): Promise<BrowserTab[]> {
    const response = await this.client.browsingContextCreate({
      type: "tab"
    });
    this.activeTabId = response.context;
    await this.client.browsingContextActivate({
      context: response.context
    });
    if (url && url !== "about:blank") {
      await this.client.browsingContextNavigate({
        context: response.context,
        url,
        wait: "complete"
      });
    }
    return this.refreshTabs();
  }

  async selectTab(tabId: string): Promise<BrowserTab[]> {
    this.activeTabId = tabId;
    await this.client.browsingContextActivate({
      context: tabId
    });
    return this.refreshTabs();
  }

  async closeTab(tabId: string): Promise<BrowserTab[]> {
    const tabsBeforeClose = await this.refreshTabs();
    const index = tabsBeforeClose.findIndex((tab) => tab.id === tabId);
    await this.client.browsingContextClose({
      context: tabId
    });
    const tabsAfterClose = await this.refreshTabs();
    if (tabsAfterClose.length === 0) {
      this.activeTabId = undefined;
      return tabsAfterClose;
    }
    const fallbackIndex = index >= 0 ? Math.min(index, tabsAfterClose.length - 1) : 0;
    this.activeTabId = tabsAfterClose[fallbackIndex]?.id;
    if (this.activeTabId) {
      await this.client.browsingContextActivate({
        context: this.activeTabId
      });
    }
    return this.refreshTabs();
  }

  async snapshot(request: BrowserSnapshotRequest = {}): Promise<BrowserSnapshot> {
    const tabId = await this.getActiveTabId();
    const result = await evaluateBiDi<AriaSnapshotResult>(
      this.client,
      tabId,
      ARIA_SNAPSHOT_EVALUATE_SOURCE,
      toAriaSnapshotPayload(request)
    );
    return toBrowserSnapshot(result, request);
  }

  async click(target: ClickTarget, options: SessionClickOptions): Promise<void> {
    const tabId = await this.getActiveTabId();
    const source = "nodeToken" in target ? ACTION_POINT_EVALUATE_SOURCE : ACTION_POINT_BY_SELECTOR_SOURCE;
    const arg = "nodeToken" in target ? { nodeToken: target.nodeToken } : { selector: target.selector };
    const point = await evaluateBiDi<{ ok: boolean; reason?: string; x?: number; y?: number }>(
      this.client,
      tabId,
      source,
      arg
    );
    if (!point.ok || point.x === undefined || point.y === undefined) {
      const isSelector = "selector" in target;
      throw new McpToolError(
        isSelector ? "invalid_target" : "stale_ref",
        isSelector
          ? `Element "${target.selector}" could not be found or is not visible.`
          : 'The referenced element is no longer valid. Call "browser_snapshot" again.'
      );
    }

    const BIDI_BUTTON: Record<string, number> = { left: 0, middle: 1, right: 2 };
    const buttonCode = BIDI_BUTTON[options.button ?? "left"] ?? 0;
    const cycles = options.doubleClick ? 2 : 1;

    const modifierKeys = (options.modifiers ?? []).map((m) => {
      const KEY_MAP: Record<string, string> = {
        Alt: "",
        Control: "",
        ControlOrMeta: "",
        Meta: "",
        Shift: ""
      };
      return KEY_MAP[m] ?? m;
    });

    const keyDownActions = modifierKeys.map((value) => ({ type: "keyDown" as const, value }));
    const keyUpActions = modifierKeys.map((value) => ({ type: "keyUp" as const, value }));

    const pointerActions: unknown[] = [
      {
        type: "pointerMove",
        x: Math.round(point.x),
        y: Math.round(point.y),
        origin: "viewport"
      }
    ];
    for (let i = 0; i < cycles; i++) {
      pointerActions.push({ type: "pointerDown", button: buttonCode });
      pointerActions.push({ type: "pause", duration: options.clickHoldMs });
      pointerActions.push({ type: "pointerUp", button: buttonCode });
    }

    const actions: unknown[] = [];
    if (modifierKeys.length > 0) {
      actions.push({ type: "key", id: "kbd", actions: [...keyDownActions, ...keyUpActions] });
    }
    actions.push({
      type: "pointer",
      id: "mouse",
      parameters: { pointerType: "mouse" },
      actions: pointerActions
    });

    await this.client.inputPerformActions({
      context: tabId,
      actions
    });
    await this.client.inputReleaseActions({ context: tabId }).catch(() => {});
  }

  async hover(target: ClickTarget): Promise<void> {
    const tabId = await this.getActiveTabId();
    const source = "nodeToken" in target ? ACTION_POINT_EVALUATE_SOURCE : ACTION_POINT_BY_SELECTOR_SOURCE;
    const arg = "nodeToken" in target ? { nodeToken: target.nodeToken } : { selector: target.selector };
    const point = await evaluateBiDi<{ ok: boolean; reason?: string; x?: number; y?: number }>(
      this.client,
      tabId,
      source,
      arg
    );
    if (!point.ok || point.x === undefined || point.y === undefined) {
      const isSelector = "selector" in target;
      throw new McpToolError(
        isSelector ? "invalid_target" : "stale_ref",
        isSelector
          ? `Element "${target.selector}" could not be found or is not visible.`
          : 'The referenced element is no longer valid. Call "browser_snapshot" again.'
      );
    }

    await this.client.inputPerformActions({
      context: tabId,
      actions: [
        {
          type: "pointer",
          id: "mouse",
          parameters: { pointerType: "mouse" },
          actions: [
            {
              type: "pointerMove",
              x: Math.round(point.x),
              y: Math.round(point.y),
              origin: "viewport"
            }
          ]
        }
      ]
    });
    await this.client.inputReleaseActions({ context: tabId }).catch(() => {});
  }

  async close(): Promise<void> {
    await this.client.sessionEnd({}).catch(() => {});
    this.client.close();
  }

  private async refreshTabs(): Promise<BrowserTab[]> {
    const response = await this.client.browsingContextGetTree({});
    const tabs = await Promise.all(
      response.contexts
        .filter((context) => context.parent === undefined || context.parent === null)
        .map(async (context) => ({
          id: context.context,
          title: await this.titleForContext(context.context),
          url: context.url
        }))
    );

    if (!this.activeTabId) {
      this.activeTabId = chooseInitialTab(tabs);
    }

    return tabs.map((tab) => ({
      ...tab,
      active: tab.id === this.activeTabId
    }));
  }

  private async getActiveTabId(): Promise<string> {
    const tabs = await this.refreshTabs();
    const activeTab = tabs.find((tab) => tab.active);
    if (!activeTab) {
      throw new McpToolError("no_active_tab", "No active tab is available.");
    }
    return activeTab.id;
  }

  private async titleForContext(contextId: string): Promise<string> {
    try {
      return await evaluateBiDi<string>(
        this.client,
        contextId,
        String.raw`() => document.title || ""`
      );
    } catch {
      return "";
    }
  }
}

export async function connectBrowserSession(
  args: RoxyBrowserConnectArgs
): Promise<ConnectedBrowserSession> {
  if (args.protocol === "cdp") {
    return CdpConnectedBrowserSession.connect(args);
  }

  return BidiConnectedBrowserSession.connect(args);
}
