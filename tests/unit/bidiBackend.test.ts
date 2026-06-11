import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BidiBrowserAdapterFactory,
  buildFirefoxLaunchArgs,
  resetBidiClientFactoryForTests,
  setBidiClientFactoryForTests,
  WebSocketBidiClient
} from "../../src/bundle.js";

const createClient = vi.fn();

function createBidiClientStub(overrides: Record<string, unknown> = {}) {
  return {
    capabilities: {
      browserName: "firefox"
    },
    close: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
    sessionStatus: vi.fn(async () => ({})),
    browsingContextGetTree: vi.fn(async () => ({ contexts: [] })),
    ...overrides
  };
}

describe("buildFirefoxLaunchArgs", () => {
  it("launches Firefox with a temporary profile and BiDi debugging port", () => {
    expect(buildFirefoxLaunchArgs({ headless: true }, "/tmp/roxy-firefox", 9222)).toEqual([
      "-profile",
      "/tmp/roxy-firefox",
      "-no-remote",
      "--remote-debugging-port=9222",
      "-headless"
    ]);
  });

  it("appends custom args after the default Firefox launch args", () => {
    expect(
      buildFirefoxLaunchArgs(
        {
          headless: false,
          args: ["-new-instance", "--private-window"]
        },
        "/tmp/roxy-firefox",
        9333
      )
    ).toEqual([
      "-profile",
      "/tmp/roxy-firefox",
      "-no-remote",
      "--remote-debugging-port=9333",
      "-new-instance",
      "--private-window"
    ]);
  });
});

describe("BidiBrowserAdapterFactory", () => {
  afterEach(() => {
    createClient.mockReset();
    resetBidiClientFactoryForTests();
    vi.unstubAllGlobals();
  });

  it("reuses an already active Firefox BiDi session at a direct websocket endpoint", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const client = createBidiClientStub();
    createClient.mockResolvedValue(client);

    const adapter = new BidiBrowserAdapterFactory().create({
      browserName: "firefox",
      protocol: "bidi",
      wsEndpoint: "ws://127.0.0.1:53453"
    });
    setBidiClientFactoryForTests(createClient);

    await adapter.connect();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(createClient).toHaveBeenCalledWith({
      webSocketUrl: "ws://127.0.0.1:53453/session",
      browserName: "firefox"
    });

    const browser = await adapter.browser();
    await expect(browser.version()).resolves.toBe("firefox");
  });

  it("uses a provided session id and keeps the external session alive on close", async () => {
    const sessionEnd = vi.fn(async () => {});
    const close = vi.fn();

    const client = createBidiClientStub({
      sessionEnd,
      close
    });
    createClient.mockResolvedValue(client);

    const adapter = new BidiBrowserAdapterFactory().create({
      browserName: "firefox",
      protocol: "bidi",
      wsEndpoint: "ws://127.0.0.1:53453",
      sessionId: "abc123"
    });
    setBidiClientFactoryForTests(createClient);

    await adapter.connect();

    expect(createClient).toHaveBeenCalledWith({
      webSocketUrl: "ws://127.0.0.1:53453/session/abc123",
      browserName: "firefox"
    });

    const browser = await adapter.browser();
    await browser.close();
    expect(sessionEnd).not.toHaveBeenCalled();

    await adapter.close();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("creates and ends a BiDi session when none exists yet", async () => {
    const sessionEnd = vi.fn(async () => {});
    const sessionNew = vi.fn(async () => ({
      sessionId: "created-session",
      capabilities: {
        browserName: "firefox"
      }
    }));
    const close = vi.fn();

    const client = createBidiClientStub({
      browsingContextGetTree: vi.fn(async () => {
        throw new Error("session does not exist");
      }),
      sessionNew,
      sessionEnd,
      close
    });
    createClient.mockResolvedValue(client);

    const adapter = new BidiBrowserAdapterFactory().create({
      browserName: "firefox",
      protocol: "bidi",
      wsEndpoint: "ws://127.0.0.1:53453"
    });
    setBidiClientFactoryForTests(createClient);

    await adapter.connect();
    const browser = await adapter.browser();
    await browser.close();

    expect(sessionNew).toHaveBeenCalledWith({
      capabilities: {
        alwaysMatch: {
          acceptInsecureCerts: true
        }
      }
    });
    expect(sessionEnd).toHaveBeenCalledWith({});
    await adapter.close();
    expect(close).toHaveBeenCalledTimes(1);
  });
});

type FakeWebSocketListener = (event?: unknown) => void;

class FakeWebSocket {
  static readonly OPEN = 1;

  readonly listeners = new Map<string, Set<FakeWebSocketListener>>();
  readonly sent: string[] = [];
  readyState = 0;
  url: string;

  constructor(url: string) {
    this.url = url;
    fakeWebSockets.push(this);
  }

  addEventListener(
    type: string,
    listener: FakeWebSocketListener,
    options?: { once?: boolean }
  ): void {
    const listeners = this.listeners.get(type) ?? new Set<FakeWebSocketListener>();
    if (options?.once) {
      const wrapped: FakeWebSocketListener = (event) => {
        listeners.delete(wrapped);
        listener(event);
      };
      listeners.add(wrapped);
    } else {
      listeners.add(listener);
    }
    this.listeners.set(type, listeners);
  }

  close(): void {
    this.readyState = 3;
    this.emit("close");
  }

  send(data: string): void {
    this.sent.push(data);
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit("open");
  }

  message(payload: unknown): void {
    this.emit("message", { data: JSON.stringify(payload) });
  }

  private emit(type: string, event?: unknown): void {
    for (const listener of Array.from(this.listeners.get(type) ?? [])) {
      listener(event);
    }
  }
}

const fakeWebSockets: FakeWebSocket[] = [];

describe("WebSocketBidiClient", () => {
  afterEach(() => {
    fakeWebSockets.length = 0;
    vi.unstubAllGlobals();
  });

  async function connectClient(): Promise<{
    client: WebSocketBidiClient;
    socket: FakeWebSocket;
  }> {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const client = new WebSocketBidiClient({
      browserName: "firefox",
      webSocketUrl: "ws://127.0.0.1:9222/session"
    });
    const socket = fakeWebSockets[0]!;
    const connected = client.connect();
    socket.open();
    await connected;
    return { client, socket };
  }

  it("matches command responses by id", async () => {
    const { client, socket } = await connectClient();

    const response = client.sendCommand("session.status", {});

    expect(JSON.parse(socket.sent[0]!)).toEqual({
      id: 1,
      method: "session.status",
      params: {}
    });

    socket.message({
      type: "success",
      id: 1,
      result: {
        ready: true,
        message: "ready"
      }
    });

    await expect(response).resolves.toEqual({
      result: {
        ready: true,
        message: "ready"
      }
    });
  });

  it("rejects protocol errors for matching commands", async () => {
    const { client, socket } = await connectClient();

    const response = client.sendCommand("browsingContext.getTree", {});
    socket.message({
      type: "error",
      id: 1,
      error: "invalid session id",
      message: "session does not exist"
    });

    await expect(response).rejects.toThrow("invalid session id: session does not exist");
  });

  it("dispatches BiDi event params to listeners", async () => {
    const { client, socket } = await connectClient();
    const listener = vi.fn();

    client.on("browsingContext.load", listener);
    socket.message({
      type: "event",
      method: "browsingContext.load",
      params: {
        context: "ctx-1"
      }
    });

    expect(listener).toHaveBeenCalledWith({
      context: "ctx-1"
    });
  });

  it("rejects pending commands when the websocket closes", async () => {
    const { client, socket } = await connectClient();

    const response = client.sendCommand("session.status", {});
    socket.close();

    await expect(response).rejects.toThrow("WebDriver BiDi connection closed.");
  });
});
