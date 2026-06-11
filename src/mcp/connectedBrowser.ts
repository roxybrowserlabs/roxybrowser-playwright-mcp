import * as cdpModule from "chrome-remote-interface";
import {
  ARIA_SNAPSHOT_EVALUATE_SOURCE,
  normalizeAriaSnapshotOptions,
  retryUntilReady,
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
  SessionClickOptions,
  SessionTypeOptions
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
    navigate(options: { url: string }): Promise<{ frameId: string; errorText?: string }>;
    goBack(): Promise<{ success: boolean }>;
    goForward(): Promise<{ success: boolean }>;
    captureScreenshot(options?: {
      format?: "jpeg" | "png";
      clip?: { x: number; y: number; width: number; height: number; scale: number };
    }): Promise<{ data: string }>;
  };
  Runtime: {
    enable(): Promise<void>;
    evaluate(options: {
      expression: string;
      returnByValue: boolean;
      awaitPromise: boolean;
    }): Promise<{ result: { value?: unknown; objectId?: string }; exceptionDetails?: { text?: string } }>;
  };
  DOM: {
    enable(options: {}): Promise<void>;
    getDocument(): Promise<{ root: { nodeId: number } }>;
    querySelector(options: { nodeId: number; selector: string }): Promise<{ nodeId: number }>;
    resolveNode(options: { objectId: string }): Promise<{ object: { objectId?: string } }>;
    setFileInputFiles(options: { nodeId?: number; objectId?: string; files: string[] }): Promise<void>;
    getBoxModel(options: { nodeId?: number; objectId?: string }): Promise<{
      model: { content: number[]; border: number[]; padding: number[] };
    }>;
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
    dispatchKeyEvent(options: {
      type: "keyDown" | "keyUp" | "rawKeyDown" | "char";
      key?: string;
      code?: string;
      windowsVirtualKeyCode?: number;
      nativeVirtualKeyCode?: number;
      text?: string;
      modifiers?: number;
    }): Promise<void>;
    insertText(options: { text: string }): Promise<void>;
    synthesizeScrollGesture(options: {
      x: number;
      y: number;
      xDistance?: number;
      yDistance?: number;
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

async function evaluateCdpRef(
  client: CdpClient,
  functionSource: string,
  arg?: unknown
): Promise<{ objectId?: string }> {
  const expression =
    arg === undefined
      ? `(${functionSource})()`
      : `(${functionSource})(${JSON.stringify(arg)})`;
  const response = await client.Runtime.evaluate({
    expression,
    returnByValue: false,
    awaitPromise: true
  });

  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.text || "CDP runtime evaluation failed.");
  }

  const objectId = response.result.objectId;
  return objectId !== undefined ? { objectId } : {};
}

const FOCUS_AND_GET_ELEMENT_SOURCE = String.raw`(payload) => {
  const state = globalThis.__roxyMcpState;
  const el = payload.nodeToken
    ? (state?.elements?.get(payload.nodeToken) ?? null)
    : document.querySelector(payload.selector);
  if (!el || !el.isConnected) return null;
  el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  el.focus();
  return el;
}`;

const TYPE_INTO_ELEMENT_SOURCE = String.raw`(payload) => {
  const state = globalThis.__roxyMcpState;
  const el = payload.nodeToken
    ? (state?.elements?.get(payload.nodeToken) ?? null)
    : document.querySelector(payload.selector);
  if (!el || !el.isConnected) return { ok: false, reason: 'not_found' };
  el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  el.focus();
  const tag = el.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea') {
    const proto = Object.getPrototypeOf(el);
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
      ?? Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (setter) setter.call(el, payload.text);
    else el.value = payload.text;
  } else if (el.isContentEditable) {
    el.textContent = payload.text;
  } else {
    return { ok: false, reason: 'not_input' };
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  if (payload.submit) {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', keyCode: 13, bubbles: true }));
    if (el.form && typeof el.form.submit === 'function') el.form.submit();
    else if (el.form) {
      el.form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    }
  }
  return { ok: true };
}`;

const SELECT_OPTION_SOURCE = String.raw`(payload) => {
  const state = globalThis.__roxyMcpState;
  const el = payload.nodeToken
    ? (state?.elements?.get(payload.nodeToken) ?? null)
    : document.querySelector(payload.selector);
  if (!el || !el.isConnected) return { ok: false, reason: 'not_found', selected: [] };
  if (el.tagName.toLowerCase() !== 'select') return { ok: false, reason: 'not_select', selected: [] };
  const selectEl = el;
  const values = payload.values;
  let matched = false;
  for (const option of selectEl.options) {
    const shouldSelect = values.includes(option.value) || values.includes(option.text);
    if (shouldSelect) {
      option.selected = true;
      matched = true;
    } else if (!selectEl.multiple) {
      option.selected = false;
    }
  }
  if (!matched) {
    // Try partial match
    for (const option of selectEl.options) {
      const shouldSelect = values.some(v => option.value.includes(v) || option.text.includes(v));
      if (shouldSelect) { option.selected = true; matched = true; }
    }
  }
  selectEl.dispatchEvent(new Event('input', { bubbles: true }));
  selectEl.dispatchEvent(new Event('change', { bubbles: true }));
  const selected = Array.from(selectEl.selectedOptions).map(o => o.value);
  return { ok: matched, selected };
}`;

const CHECK_ELEMENT_SOURCE = String.raw`(payload) => {
  const state = globalThis.__roxyMcpState;
  const el = payload.nodeToken
    ? (state?.elements?.get(payload.nodeToken) ?? null)
    : document.querySelector(payload.selector);
  if (!el || !el.isConnected) return { ok: false, reason: 'not_found' };
  const tag = el.tagName.toLowerCase();
  const type = el.getAttribute('type')?.toLowerCase();
  if (tag === 'input' && (type === 'checkbox' || type === 'radio')) {
    if (el.checked !== payload.checked) {
      el.click();
    }
    return { ok: true };
  }
  const role = el.getAttribute('role');
  if (role === 'checkbox' || role === 'switch') {
    const current = el.getAttribute('aria-checked') === 'true';
    if (current !== payload.checked) {
      el.click();
    }
    return { ok: true };
  }
  return { ok: false, reason: 'not_checkable' };
}`;

const SCROLL_ELEMENT_SOURCE = String.raw`(payload) => {
  const state = globalThis.__roxyMcpState;
  const el = payload.nodeToken
    ? (state?.elements?.get(payload.nodeToken) ?? null)
    : payload.selector ? document.querySelector(payload.selector) : null;
  const target = el ?? document.documentElement;
  target.scrollBy({ left: payload.deltaX, top: payload.deltaY, behavior: 'instant' });
  return { ok: true };
}`;

const GET_ELEMENT_OBJECT_SOURCE = String.raw`(payload) => {
  const state = globalThis.__roxyMcpState;
  return payload.nodeToken
    ? (state?.elements?.get(payload.nodeToken) ?? null)
    : document.querySelector(payload.selector);
}`;

const CDP_KEY_MAP: Record<string, { key: string; code: string; keyCode: number; text?: string }> = {
  Enter:      { key: "Enter",     code: "Enter",       keyCode: 13, text: "\r" },
  Return:     { key: "Enter",     code: "Enter",       keyCode: 13, text: "\r" },
  Escape:     { key: "Escape",    code: "Escape",      keyCode: 27 },
  Tab:        { key: "Tab",       code: "Tab",         keyCode: 9 },
  Backspace:  { key: "Backspace", code: "Backspace",   keyCode: 8 },
  Delete:     { key: "Delete",    code: "Delete",      keyCode: 46 },
  ArrowLeft:  { key: "ArrowLeft", code: "ArrowLeft",   keyCode: 37 },
  ArrowRight: { key: "ArrowRight",code: "ArrowRight",  keyCode: 39 },
  ArrowUp:    { key: "ArrowUp",   code: "ArrowUp",     keyCode: 38 },
  ArrowDown:  { key: "ArrowDown", code: "ArrowDown",   keyCode: 40 },
  Home:       { key: "Home",      code: "Home",        keyCode: 36 },
  End:        { key: "End",       code: "End",         keyCode: 35 },
  PageUp:     { key: "PageUp",    code: "PageUp",      keyCode: 33 },
  PageDown:   { key: "PageDown",  code: "PageDown",    keyCode: 34 },
  Insert:     { key: "Insert",    code: "Insert",      keyCode: 45 },
  Space:      { key: " ",         code: "Space",       keyCode: 32, text: " " },
  F1:  { key: "F1",  code: "F1",  keyCode: 112 },
  F2:  { key: "F2",  code: "F2",  keyCode: 113 },
  F3:  { key: "F3",  code: "F3",  keyCode: 114 },
  F4:  { key: "F4",  code: "F4",  keyCode: 115 },
  F5:  { key: "F5",  code: "F5",  keyCode: 116 },
  F6:  { key: "F6",  code: "F6",  keyCode: 117 },
  F7:  { key: "F7",  code: "F7",  keyCode: 118 },
  F8:  { key: "F8",  code: "F8",  keyCode: 119 },
  F9:  { key: "F9",  code: "F9",  keyCode: 120 },
  F10: { key: "F10", code: "F10", keyCode: 121 },
  F11: { key: "F11", code: "F11", keyCode: 122 },
  F12: { key: "F12", code: "F12", keyCode: 123 },
};

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
    const result = await retryUntilReady(() =>
      evaluateCdp<AriaSnapshotResult>(pageClient, ARIA_SNAPSHOT_EVALUATE_SOURCE, toAriaSnapshotPayload(request))
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

  async navigate(url: string): Promise<void> {
    const pageClient = await this.getActivePageClient();
    await pageClient.Page.navigate({ url });
  }

  async type(target: ClickTarget, text: string, options?: SessionTypeOptions): Promise<void> {
    const pageClient = await this.getActivePageClient();
    const arg = this.targetArg(target);
    const result = await evaluateCdp<{ ok: boolean; reason?: string }>(
      pageClient,
      TYPE_INTO_ELEMENT_SOURCE,
      { ...arg, text, submit: options?.submit ?? false }
    );
    if (!result.ok) {
      const isSelector = "selector" in target;
      throw new McpToolError(
        isSelector ? "invalid_target" : "stale_ref",
        result.reason === "not_found"
          ? (isSelector ? `Element "${target.selector}" could not be found.` : 'The referenced element is no longer valid. Call "browser_snapshot" again.')
          : `Element is not a typeable input.`
      );
    }
  }

  async pressKey(
    key: string,
    modifiers?: Array<"Alt" | "Control" | "ControlOrMeta" | "Meta" | "Shift">
  ): Promise<void> {
    const pageClient = await this.getActivePageClient();

    const MODIFIER_BITS: Record<string, number> = {
      Alt: 1, Control: 2, ControlOrMeta: 2, Meta: 4, Shift: 8
    };
    const modifiersMask = (modifiers ?? []).reduce(
      (acc, m) => acc | (MODIFIER_BITS[m] ?? 0), 0
    );

    const mapped = CDP_KEY_MAP[key];
    if (mapped) {
      await pageClient.Input.dispatchKeyEvent({
        type: "keyDown",
        key: mapped.key,
        code: mapped.code,
        windowsVirtualKeyCode: mapped.keyCode,
        nativeVirtualKeyCode: mapped.keyCode,
        ...(mapped.text ? { text: mapped.text } : {}),
        modifiers: modifiersMask
      });
      await pageClient.Input.dispatchKeyEvent({
        type: "keyUp",
        key: mapped.key,
        code: mapped.code,
        windowsVirtualKeyCode: mapped.keyCode,
        nativeVirtualKeyCode: mapped.keyCode,
        modifiers: modifiersMask
      });
    } else {
      // Printable single character
      await pageClient.Input.insertText({ text: key });
    }
  }

  async selectOption(target: ClickTarget, values: string[]): Promise<string[]> {
    const pageClient = await this.getActivePageClient();
    const arg = this.targetArg(target);
    const result = await evaluateCdp<{ ok: boolean; reason?: string; selected: string[] }>(
      pageClient,
      SELECT_OPTION_SOURCE,
      { ...arg, values }
    );
    if (!result.ok) {
      const isSelector = "selector" in target;
      throw new McpToolError(
        isSelector ? "invalid_target" : "stale_ref",
        result.reason === "not_found"
          ? (isSelector ? `Element "${target.selector}" could not be found.` : 'The referenced element is no longer valid.')
          : `Element is not a <select> element.`
      );
    }
    return result.selected;
  }

  async check(target: ClickTarget, checked: boolean): Promise<void> {
    const pageClient = await this.getActivePageClient();
    const arg = this.targetArg(target);
    const result = await evaluateCdp<{ ok: boolean; reason?: string }>(
      pageClient,
      CHECK_ELEMENT_SOURCE,
      { ...arg, checked }
    );
    if (!result.ok) {
      const isSelector = "selector" in target;
      throw new McpToolError(
        isSelector ? "invalid_target" : "stale_ref",
        result.reason === "not_found"
          ? (isSelector ? `Element "${target.selector}" could not be found.` : 'The referenced element is no longer valid.')
          : `Element is not a checkbox or radio button.`
      );
    }
  }

  async goBack(): Promise<void> {
    const pageClient = await this.getActivePageClient();
    await pageClient.Page.goBack().catch(() => {});
  }

  async goForward(): Promise<void> {
    const pageClient = await this.getActivePageClient();
    await pageClient.Page.goForward().catch(() => {});
  }

  async scroll(target: ClickTarget | null, deltaX: number, deltaY: number): Promise<void> {
    const pageClient = await this.getActivePageClient();
    const arg = target ? this.targetArg(target) : {};
    await evaluateCdp<{ ok: boolean }>(pageClient, SCROLL_ELEMENT_SOURCE, { ...arg, deltaX, deltaY });
  }

  async screenshot(): Promise<string> {
    const pageClient = await this.getActivePageClient();
    const result = await pageClient.Page.captureScreenshot({ format: "png" });
    return result.data;
  }

  async uploadFile(target: ClickTarget, filePaths: string[]): Promise<void> {
    const pageClient = await this.getActivePageClient();
    const arg = this.targetArg(target);
    const refResult = await evaluateCdpRef(pageClient, GET_ELEMENT_OBJECT_SOURCE, arg);
    if (!refResult.objectId) {
      const isSelector = "selector" in target;
      throw new McpToolError(
        isSelector ? "invalid_target" : "stale_ref",
        isSelector ? `Element "${target.selector}" could not be found.` : 'The referenced element is no longer valid.'
      );
    }
    await pageClient.DOM.setFileInputFiles({ objectId: refResult.objectId, files: filePaths });
  }

  private targetArg(target: ClickTarget): { nodeToken?: string; selector?: string } {
    return "nodeToken" in target
      ? { nodeToken: target.nodeToken }
      : { selector: target.selector };
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

  async navigate(url: string): Promise<void> {
    const tabId = await this.getActiveTabId();
    await this.client.browsingContextNavigate({ context: tabId, url, wait: "complete" });
  }

  async type(target: ClickTarget, text: string, options?: SessionTypeOptions): Promise<void> {
    const tabId = await this.getActiveTabId();
    const arg = "nodeToken" in target ? { nodeToken: target.nodeToken } : { selector: target.selector };
    const result = await evaluateBiDi<{ ok: boolean; reason?: string }>(
      this.client,
      tabId,
      TYPE_INTO_ELEMENT_SOURCE,
      { ...arg, text, submit: options?.submit ?? false }
    );
    if (!result.ok) {
      const isSelector = "selector" in target;
      throw new McpToolError(
        isSelector ? "invalid_target" : "stale_ref",
        result.reason === "not_found"
          ? (isSelector ? `Element "${target.selector}" could not be found.` : 'The referenced element is no longer valid.')
          : `Element is not a typeable input.`
      );
    }
  }

  async pressKey(
    key: string,
    modifiers?: Array<"Alt" | "Control" | "ControlOrMeta" | "Meta" | "Shift">
  ): Promise<void> {
    const tabId = await this.getActiveTabId();

    // WebDriver BiDi uses Unicode Private Use Area for special keys
    const BIDI_SPECIAL_KEY: Record<string, string> = {
      Enter: "", Return: "", Escape: "",
      Tab: "", Backspace: "", Delete: "",
      ArrowLeft: "", ArrowRight: "", ArrowUp: "", ArrowDown: "",
      Home: "", End: "", PageUp: "", PageDown: "",
      Insert: "", Space: " ",
      F1: "", F2: "", F3: "", F4: "",
      F5: "", F6: "", F7: "", F8: "",
      F9: "", F10: "", F11: "", F12: "",
    };
    const BIDI_MODIFIER_KEY: Record<string, string> = {
      Alt: "", Control: "", ControlOrMeta: "",
      Meta: "", Shift: ""
    };

    const keyValue = BIDI_SPECIAL_KEY[key] ?? key;
    const modifierKeys = (modifiers ?? []).map((m) => BIDI_MODIFIER_KEY[m] ?? m);

    const keyDownActions = modifierKeys.map((value) => ({ type: "keyDown" as const, value }));
    const keyUpActions = [...modifierKeys].reverse().map((value) => ({ type: "keyUp" as const, value }));

    await this.client.inputPerformActions({
      context: tabId,
      actions: [
        {
          type: "key",
          id: "kbd",
          actions: [
            ...keyDownActions,
            { type: "keyDown" as const, value: keyValue },
            { type: "keyUp" as const, value: keyValue },
            ...keyUpActions
          ]
        }
      ]
    } as Parameters<typeof this.client.inputPerformActions>[0]);
    await this.client.inputReleaseActions({ context: tabId }).catch(() => {});
  }

  async selectOption(target: ClickTarget, values: string[]): Promise<string[]> {
    const tabId = await this.getActiveTabId();
    const arg = "nodeToken" in target ? { nodeToken: target.nodeToken } : { selector: target.selector };
    const result = await evaluateBiDi<{ ok: boolean; reason?: string; selected: string[] }>(
      this.client, tabId, SELECT_OPTION_SOURCE, { ...arg, values }
    );
    if (!result.ok) {
      const isSelector = "selector" in target;
      throw new McpToolError(
        isSelector ? "invalid_target" : "stale_ref",
        result.reason === "not_found"
          ? (isSelector ? `Element "${target.selector}" could not be found.` : 'The referenced element is no longer valid.')
          : `Element is not a <select> element.`
      );
    }
    return result.selected;
  }

  async check(target: ClickTarget, checked: boolean): Promise<void> {
    const tabId = await this.getActiveTabId();
    const arg = "nodeToken" in target ? { nodeToken: target.nodeToken } : { selector: target.selector };
    const result = await evaluateBiDi<{ ok: boolean; reason?: string }>(
      this.client, tabId, CHECK_ELEMENT_SOURCE, { ...arg, checked }
    );
    if (!result.ok) {
      const isSelector = "selector" in target;
      throw new McpToolError(
        isSelector ? "invalid_target" : "stale_ref",
        result.reason === "not_found"
          ? (isSelector ? `Element "${target.selector}" could not be found.` : 'The referenced element is no longer valid.')
          : `Element is not a checkbox or radio button.`
      );
    }
  }

  async goBack(): Promise<void> {
    const tabId = await this.getActiveTabId();
    await this.client.browsingContextTraverseHistory({ context: tabId, delta: -1 }).catch(() => {});
  }

  async goForward(): Promise<void> {
    const tabId = await this.getActiveTabId();
    await this.client.browsingContextTraverseHistory({ context: tabId, delta: 1 }).catch(() => {});
  }

  async scroll(target: ClickTarget | null, deltaX: number, deltaY: number): Promise<void> {
    const tabId = await this.getActiveTabId();
    const arg = target ? ("nodeToken" in target ? { nodeToken: target.nodeToken } : { selector: target.selector }) : {};
    await evaluateBiDi<{ ok: boolean }>(this.client, tabId, SCROLL_ELEMENT_SOURCE, { ...arg, deltaX, deltaY });
  }

  async screenshot(): Promise<string> {
    const tabId = await this.getActiveTabId();
    const result = await this.client.browsingContextCaptureScreenshot({ context: tabId });
    return (result as unknown as { data: string }).data;
  }

  async uploadFile(_target: ClickTarget, _filePaths: string[]): Promise<void> {
    // BiDi has no setFiles equivalent and browsers block programmatic file
    // input assignment, so there is no workaround over this protocol.
    throw new McpToolError(
      "not_supported",
      "File upload is not supported over the BiDi protocol. Use CDP instead."
    );
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
