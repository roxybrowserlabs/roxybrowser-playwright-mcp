import type { Commands } from "webdriver-bidi-protocol";

type BidiCommandName = keyof Commands;

type BidiCommandResponse<T extends BidiCommandName> = {
  result: Commands[T]["returnType"];
};

type BidiEventListener = (payload: unknown) => void;

type WebSocketLike = {
  readonly readyState: number;
  addEventListener(type: "open", listener: () => void, options?: { once?: boolean }): void;
  addEventListener(type: "error", listener: (event: unknown) => void, options?: { once?: boolean }): void;
  addEventListener(type: "close", listener: () => void, options?: { once?: boolean }): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  close(): void;
  send(data: string): void;
};

export interface BidiProtocolClient {
  capabilities: {
    browserName?: string;
    browserVersion?: string;
  };
  close(): void;
  on(event: string, listener: BidiEventListener): void;
  removeListener(event: string, listener: BidiEventListener): void;
  sendCommand<T extends BidiCommandName>(
    method: T,
    params: Commands[T]["params"]
  ): Promise<BidiCommandResponse<T>>;

  browserCreateUserContext(params: unknown): Promise<Commands["browser.createUserContext"]["returnType"]>;
  browserRemoveUserContext(params: unknown): Promise<Commands["browser.removeUserContext"]["returnType"]>;
  browsingContextActivate(params: unknown): Promise<Commands["browsingContext.activate"]["returnType"]>;
  browsingContextCaptureScreenshot(
    params: unknown
  ): Promise<Commands["browsingContext.captureScreenshot"]["returnType"]>;
  browsingContextClose(params: unknown): Promise<Commands["browsingContext.close"]["returnType"]>;
  browsingContextCreate(params: unknown): Promise<Commands["browsingContext.create"]["returnType"]>;
  browsingContextGetTree(params: unknown): Promise<Commands["browsingContext.getTree"]["returnType"]>;
  browsingContextHandleUserPrompt(
    params: unknown
  ): Promise<Commands["browsingContext.handleUserPrompt"]["returnType"]>;
  browsingContextNavigate(params: unknown): Promise<Commands["browsingContext.navigate"]["returnType"]>;
  browsingContextReload(params: unknown): Promise<Commands["browsingContext.reload"]["returnType"]>;
  browsingContextSetViewport(
    params: unknown
  ): Promise<Commands["browsingContext.setViewport"]["returnType"]>;
  browsingContextTraverseHistory(
    params: unknown
  ): Promise<Commands["browsingContext.traverseHistory"]["returnType"]>;
  emulationSetLocaleOverride(params: unknown): Promise<Commands["emulation.setLocaleOverride"]["returnType"]>;
  emulationSetTimezoneOverride(
    params: unknown
  ): Promise<Commands["emulation.setTimezoneOverride"]["returnType"]>;
  emulationSetUserAgentOverride(
    params: unknown
  ): Promise<Commands["emulation.setUserAgentOverride"]["returnType"]>;
  inputPerformActions(params: unknown): Promise<Commands["input.performActions"]["returnType"]>;
  inputReleaseActions(params: unknown): Promise<Commands["input.releaseActions"]["returnType"]>;
  inputSetFiles(params: unknown): Promise<Commands["input.setFiles"]["returnType"]>;
  networkAddDataCollector(params: unknown): Promise<Commands["network.addDataCollector"]["returnType"]>;
  networkGetData(params: unknown): Promise<Commands["network.getData"]["returnType"]>;
  networkRemoveDataCollector(params: unknown): Promise<Commands["network.removeDataCollector"]["returnType"]>;
  networkSetExtraHeaders(params: unknown): Promise<Commands["network.setExtraHeaders"]["returnType"]>;
  scriptAddPreloadScript(params: unknown): Promise<Commands["script.addPreloadScript"]["returnType"]>;
  scriptRemovePreloadScript(params: unknown): Promise<Commands["script.removePreloadScript"]["returnType"]>;
  scriptEvaluate(params: unknown): Promise<Commands["script.evaluate"]["returnType"]>;
  sessionEnd(params: unknown): Promise<Commands["session.end"]["returnType"]>;
  sessionNew(params: unknown): Promise<Commands["session.new"]["returnType"]>;
  sessionStatus(params: unknown): Promise<Commands["session.status"]["returnType"]>;
  sessionSubscribe(params: unknown): Promise<Commands["session.subscribe"]["returnType"]>;
  sessionUnsubscribe(params: unknown): Promise<Commands["session.unsubscribe"]["returnType"]>;
}

export interface BidiClientFactoryOptions {
  browserName: string;
  webSocketUrl: string;
}

type PendingCommand = {
  reject: (error: Error) => void;
  resolve: (result: unknown) => void;
};

type BidiSuccessMessage = {
  id: number;
  result: unknown;
  type: "success";
};

type BidiErrorMessage = {
  error: string;
  id: number | null;
  message: string;
  stacktrace?: string;
  type: "error";
};

type BidiEventMessage = {
  method: string;
  params?: unknown;
  type: "event";
};

type BidiMessage = BidiSuccessMessage | BidiErrorMessage | BidiEventMessage;

export async function createBidiClient(
  options: BidiClientFactoryOptions
): Promise<BidiProtocolClient> {
  const client = new WebSocketBidiClient(options);
  await client.connect();
  return client;
}

export class WebSocketBidiClient implements BidiProtocolClient {
  capabilities: BidiProtocolClient["capabilities"];

  private commandId = 0;
  private closed = false;
  private readonly eventListeners = new Map<string, Set<BidiEventListener>>();
  private readonly pendingCommands = new Map<number, PendingCommand>();
  private readonly socket: WebSocketLike;
  private readonly webSocketUrl: string;

  constructor(options: BidiClientFactoryOptions) {
    this.capabilities = {
      browserName: options.browserName
    };
    this.webSocketUrl = options.webSocketUrl;
    this.socket = new globalThis.WebSocket(options.webSocketUrl) as WebSocketLike;
    this.socket.addEventListener("message", (event) => this.handleMessage(event.data));
    this.socket.addEventListener("close", () => this.handleClose());
  }

  connect(): Promise<void> {
    if (this.socket.readyState === globalThis.WebSocket.OPEN) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener(
        "error",
        (event) => {
          reject(new Error(formatBidiConnectError(event, this.webSocketUrl)));
        },
        { once: true }
      );
    });
  }

  close(): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.socket.close();
    this.rejectPendingCommands(new Error("WebDriver BiDi connection closed."));
  }

  on(event: string, listener: BidiEventListener): void {
    const listeners = this.eventListeners.get(event) ?? new Set<BidiEventListener>();
    listeners.add(listener);
    this.eventListeners.set(event, listeners);
  }

  removeListener(event: string, listener: BidiEventListener): void {
    const listeners = this.eventListeners.get(event);
    listeners?.delete(listener);
    if (listeners?.size === 0) {
      this.eventListeners.delete(event);
    }
  }

  async sendCommand<T extends BidiCommandName>(
    method: T,
    params: Commands[T]["params"]
  ): Promise<BidiCommandResponse<T>> {
    if (this.closed) {
      throw new Error("WebDriver BiDi connection is closed.");
    }

    const id = ++this.commandId;
    const result = await new Promise<Commands[T]["returnType"]>((resolve, reject) => {
      this.pendingCommands.set(id, {
        resolve: (payload) => resolve(payload as Commands[T]["returnType"]),
        reject
      });

      try {
        this.socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        this.pendingCommands.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });

    return { result };
  }

  async browserCreateUserContext(params: unknown) {
    return (await this.sendCommand("browser.createUserContext", params as Commands["browser.createUserContext"]["params"])).result;
  }

  async browserRemoveUserContext(params: unknown) {
    return (await this.sendCommand("browser.removeUserContext", params as Commands["browser.removeUserContext"]["params"])).result;
  }

  async browsingContextActivate(params: unknown) {
    return (await this.sendCommand("browsingContext.activate", params as Commands["browsingContext.activate"]["params"])).result;
  }

  async browsingContextCaptureScreenshot(params: unknown) {
    return (await this.sendCommand("browsingContext.captureScreenshot", params as Commands["browsingContext.captureScreenshot"]["params"])).result;
  }

  async browsingContextClose(params: unknown) {
    return (await this.sendCommand("browsingContext.close", params as Commands["browsingContext.close"]["params"])).result;
  }

  async browsingContextCreate(params: unknown) {
    return (await this.sendCommand("browsingContext.create", params as Commands["browsingContext.create"]["params"])).result;
  }

  async browsingContextGetTree(params: unknown) {
    return (await this.sendCommand("browsingContext.getTree", params as Commands["browsingContext.getTree"]["params"])).result;
  }

  async browsingContextHandleUserPrompt(params: unknown) {
    return (await this.sendCommand("browsingContext.handleUserPrompt", params as Commands["browsingContext.handleUserPrompt"]["params"])).result;
  }

  async browsingContextNavigate(params: unknown) {
    return (await this.sendCommand("browsingContext.navigate", params as Commands["browsingContext.navigate"]["params"])).result;
  }

  async browsingContextReload(params: unknown) {
    return (await this.sendCommand("browsingContext.reload", params as Commands["browsingContext.reload"]["params"])).result;
  }

  async browsingContextSetViewport(params: unknown) {
    return (await this.sendCommand("browsingContext.setViewport", params as Commands["browsingContext.setViewport"]["params"])).result;
  }

  async browsingContextTraverseHistory(params: unknown) {
    return (await this.sendCommand("browsingContext.traverseHistory", params as Commands["browsingContext.traverseHistory"]["params"])).result;
  }

  async emulationSetLocaleOverride(params: unknown) {
    return (await this.sendCommand("emulation.setLocaleOverride", params as Commands["emulation.setLocaleOverride"]["params"])).result;
  }

  async emulationSetTimezoneOverride(params: unknown) {
    return (await this.sendCommand("emulation.setTimezoneOverride", params as Commands["emulation.setTimezoneOverride"]["params"])).result;
  }

  async emulationSetUserAgentOverride(params: unknown) {
    return (await this.sendCommand("emulation.setUserAgentOverride", params as Commands["emulation.setUserAgentOverride"]["params"])).result;
  }

  async inputPerformActions(params: unknown) {
    return (await this.sendCommand("input.performActions", params as Commands["input.performActions"]["params"])).result;
  }

  async inputReleaseActions(params: unknown) {
    return (await this.sendCommand("input.releaseActions", params as Commands["input.releaseActions"]["params"])).result;
  }

  async inputSetFiles(params: unknown) {
    return (await this.sendCommand("input.setFiles", params as Commands["input.setFiles"]["params"])).result;
  }

  async networkAddDataCollector(params: unknown) {
    return (await this.sendCommand("network.addDataCollector", params as Commands["network.addDataCollector"]["params"])).result;
  }

  async networkGetData(params: unknown) {
    return (await this.sendCommand("network.getData", params as Commands["network.getData"]["params"])).result;
  }

  async networkRemoveDataCollector(params: unknown) {
    return (await this.sendCommand("network.removeDataCollector", params as Commands["network.removeDataCollector"]["params"])).result;
  }

  async networkSetExtraHeaders(params: unknown) {
    return (await this.sendCommand("network.setExtraHeaders", params as Commands["network.setExtraHeaders"]["params"])).result;
  }

  async scriptAddPreloadScript(params: unknown) {
    return (await this.sendCommand("script.addPreloadScript", params as Commands["script.addPreloadScript"]["params"])).result;
  }

  async scriptRemovePreloadScript(params: unknown) {
    return (await this.sendCommand("script.removePreloadScript", params as Commands["script.removePreloadScript"]["params"])).result;
  }

  async scriptEvaluate(params: unknown) {
    return (await this.sendCommand("script.evaluate", params as Commands["script.evaluate"]["params"])).result;
  }

  async sessionEnd(params: unknown) {
    return (await this.sendCommand("session.end", params as Commands["session.end"]["params"])).result;
  }

  async sessionNew(params: unknown) {
    const result = (await this.sendCommand("session.new", params as Commands["session.new"]["params"])).result;
    this.capabilities = {
      browserName: result.capabilities.browserName,
      browserVersion: result.capabilities.browserVersion
    };
    return result;
  }

  async sessionStatus(params: unknown) {
    return (await this.sendCommand("session.status", params as Commands["session.status"]["params"])).result;
  }

  async sessionSubscribe(params: unknown) {
    return (await this.sendCommand("session.subscribe", params as Commands["session.subscribe"]["params"])).result;
  }

  async sessionUnsubscribe(params: unknown) {
    return (await this.sendCommand("session.unsubscribe", params as Commands["session.unsubscribe"]["params"])).result;
  }

  private handleClose(): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.rejectPendingCommands(new Error("WebDriver BiDi connection closed."));
  }

  private handleMessage(data: unknown): void {
    let message: BidiMessage;
    try {
      message = JSON.parse(String(data)) as BidiMessage;
    } catch {
      return;
    }

    if (message.type === "success") {
      const pending = this.pendingCommands.get(message.id);
      if (!pending) {
        return;
      }
      this.pendingCommands.delete(message.id);
      pending.resolve(message.result);
      return;
    }

    if (message.type === "error") {
      if (message.id === null) {
        return;
      }
      const pending = this.pendingCommands.get(message.id);
      if (!pending) {
        return;
      }
      this.pendingCommands.delete(message.id);
      pending.reject(new Error(`${message.error}: ${message.message}`));
      return;
    }

    const listeners = this.eventListeners.get(message.method);
    if (!listeners) {
      return;
    }

    for (const listener of Array.from(listeners)) {
      listener(message.params);
    }
  }

  private rejectPendingCommands(error: Error): void {
    for (const pending of this.pendingCommands.values()) {
      pending.reject(error);
    }
    this.pendingCommands.clear();
  }
}

function formatBidiConnectError(event: unknown, webSocketUrl: string): string {
  const details = extractBidiConnectErrorDetails(event);
  return details
    ? `Failed to establish a WebDriver BiDi connection to ${webSocketUrl}: ${details}`
    : `Failed to establish a WebDriver BiDi connection to ${webSocketUrl}.`;
}

function extractBidiConnectErrorDetails(event: unknown): string | undefined {
  if (event instanceof Error) {
    return event.message;
  }

  if (!event || typeof event !== "object") {
    return typeof event === "string" ? event : undefined;
  }

  const candidate = event as {
    message?: unknown;
    type?: unknown;
    error?: unknown;
    target?: { url?: unknown; readyState?: unknown } | null;
    currentTarget?: { url?: unknown; readyState?: unknown } | null;
  };

  const parts: string[] = [];
  if (typeof candidate.message === "string" && candidate.message) {
    parts.push(candidate.message);
  }
  if (typeof candidate.error === "string" && candidate.error) {
    parts.push(candidate.error);
  } else if (candidate.error instanceof Error && candidate.error.message) {
    parts.push(candidate.error.message);
  }

  const socketLike = candidate.target ?? candidate.currentTarget;
  if (socketLike && typeof socketLike === "object") {
    const socketParts: string[] = [];
    if (typeof socketLike.url === "string" && socketLike.url) {
      socketParts.push(`url=${socketLike.url}`);
    }
    if (typeof socketLike.readyState === "number") {
      socketParts.push(`readyState=${socketLike.readyState}`);
    }
    if (socketParts.length > 0) {
      parts.push(`socket(${socketParts.join(", ")})`);
    }
  }

  if (parts.length > 0) {
    return parts.join("; ");
  }

  if (typeof candidate.type === "string" && candidate.type) {
    return `event type=${candidate.type}`;
  }

  return undefined;
}

export type BidiClientFactory = (
  options: BidiClientFactoryOptions
) => Promise<BidiProtocolClient>;

let bidiClientFactory: BidiClientFactory = createBidiClient;

export function getBidiClientFactory(): BidiClientFactory {
  return bidiClientFactory;
}

export function setBidiClientFactoryForTests(factory: BidiClientFactory): void {
  bidiClientFactory = factory;
}

export function resetBidiClientFactoryForTests(): void {
  bidiClientFactory = createBidiClient;
}
