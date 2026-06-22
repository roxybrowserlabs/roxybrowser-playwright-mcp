import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withPage } from "../../helpers/browser.js";

describe("page websocket contract e2e", () => {
  let server: MinimalWebSocketServer;

  beforeAll(async () => {
    server = await MinimalWebSocketServer.create();
  });

  afterAll(async () => {
    await server.stop();
  });

  it("works like Playwright smoke", async () => {
    await withPage(async (page) => {
      server.sendOnNextConnection("incoming");

      const value = await page.evaluate((url) => {
        let resolveValue!: (value: string) => void;
        const result = new Promise<string>((resolve) => {
          resolveValue = resolve;
        });
        const socket = new WebSocket(url);
        socket.addEventListener("message", (event) => {
          socket.close();
          resolveValue(String(event.data));
        });
        return result;
      }, server.url());

      expect(value).toBe("incoming");
    });
  });

  it("emits websocket close events like Playwright", async () => {
    await withPage(async (page) => {
      const log: string[] = [];
      let closed!: () => void;
      const closedPromise = new Promise<void>((resolve) => {
        closed = resolve;
      });
      let webSocket: Awaited<ReturnType<typeof page.waitForEvent<"websocket">>> | null = null;

      page.on("websocket", (candidate) => {
        log.push(`open<${candidate.url()}>`);
        webSocket = candidate;
        candidate.on("close", () => {
          log.push("close");
          closed();
        });
      });

      await page.evaluate((url) => {
        const socket = new WebSocket(url);
        socket.addEventListener("open", () => {
          socket.close();
        });
      }, server.url());

      await closedPromise;
      expect(log.join(":")).toBe(`open<${server.url()}>:close`);
      expect(webSocket?.isClosed()).toBe(true);
    });
  });

  it("emits websocket frame and close events", async () => {
    await withPage(async (page) => {
      const log: string[] = [];
      let closed!: () => void;
      const closedPromise = new Promise<void>((resolve) => {
        closed = resolve;
      });

      page.on("websocket", (webSocket) => {
        log.push(`open<${webSocket.url()}>`);
        webSocket.on("framesent", (data) => log.push(`sent<${data.payload.toString()}>`));
        webSocket.on("framereceived", (data) => log.push(`received<${data.payload.toString()}>`));
        webSocket.on("close", () => {
          log.push(`close<${webSocket.isClosed()}>`);
          closed();
        });
      });

      await page.evaluate((url) => {
        const socket = new WebSocket(url);
        socket.addEventListener("open", () => socket.send("outgoing"));
        socket.addEventListener("message", () => socket.close());
      }, server.url());
      await closedPromise;

      expect(log).toEqual([
        `open<${server.url()}>`,
        "sent<outgoing>",
        "received<incoming>",
        "close<true>"
      ]);
    });
  });

  it("filters websocket close frames with a reason like Playwright", async () => {
    await withPage(async (page) => {
      server.sendOnNextConnection("incoming");
      server.closeNextConnectionOnFirstMessage(1003, "closed by Playwright test-server");
      const log: string[] = [];
      let closed!: () => void;
      const closedPromise = new Promise<void>((resolve) => {
        closed = resolve;
      });

      page.on("websocket", (webSocket) => {
        log.push("open");
        webSocket.on("framesent", (data) => log.push(`sent<${data.payload.toString()}>`));
        webSocket.on("framereceived", (data) => log.push(`received<${data.payload.toString()}>`));
        webSocket.on("close", () => {
          log.push("close");
          closed();
        });
      });

      await page.evaluate((url) => {
        const socket = new WebSocket(url);
        socket.addEventListener("message", () => {
          socket.send("outgoing");
        });
        window["ws"] = socket;
      }, server.url());

      await closedPromise;
      expect(log).toEqual(["open", "received<incoming>", "sent<outgoing>", "close"]);
    });
  });

  it("rejects websocket waiters when the socket closes like Playwright", async () => {
    await withPage(async (page) => {
      server.keepNextConnectionOpen();
      const [webSocket] = await Promise.all([
        page.waitForEvent("websocket").then(async (candidate) => {
          await candidate.waitForEvent("framereceived");
          return candidate;
        }),
        page.evaluate((url) => {
          const socket = new WebSocket(url);
          socket.addEventListener("open", () => socket.send("outgoing"));
          window["ws"] = socket;
        }, server.url())
      ]);

      const error = webSocket.waitForEvent("framesent").catch((caught) => caught as Error);
      await page.evaluate(() => {
        window["ws"].close();
      });

      expect((await error).message).toContain("Socket closed");
    });
  });

  it("passes self to websocket close listeners like Playwright", async () => {
    await withPage(async (page) => {
      let resolveClosed!: (value: unknown) => void;
      const closedPromise = new Promise<unknown>((resolve) => {
        resolveClosed = resolve;
      });
      let webSocket: Awaited<ReturnType<typeof page.waitForEvent<"websocket">>> | null = null;

      page.on("websocket", (candidate) => {
        webSocket = candidate;
        candidate.on("close", resolveClosed);
      });

      await page.evaluate((url) => {
        const socket = new WebSocket(url);
        socket.addEventListener("open", () => socket.close());
      }, server.url());

      const eventArg = await closedPromise;
      expect(eventArg).toBe(webSocket);
    });
  });

  it("emits websocket socketerror like Playwright", async () => {
    await withPage(async (page) => {
      let resolveError!: (value: string) => void;
      const errorPromise = new Promise<string>((resolve) => {
        resolveError = resolve;
      });

      page.on("websocket", (webSocket) => {
        webSocket.on("socketerror", resolveError);
      });

      await page.evaluate((url) => {
        new WebSocket(url);
      }, server.badUrl());

      expect(await errorPromise).toContain("400");
    });
  });

  it("does not emit stray websocket socketerror events on normal close", async () => {
    await withPage(async (page) => {
      server.keepNextConnectionOpen();
      let socketError: string | null = null;

      page.on("websocket", (webSocket) => {
        webSocket.on("socketerror", (error) => {
          socketError = error;
        });
      });

      await Promise.all([
        page.waitForEvent("websocket").then(async (candidate) => {
          await candidate.waitForEvent("framereceived");
          return candidate;
        }),
        page.evaluate((url) => {
          const socket = new WebSocket(url);
          socket.addEventListener("open", () => {
            socket.send("outgoing");
          });
          window["ws"] = socket;
        }, server.url())
      ]);

      await page.evaluate(() => {
        window["ws"].close();
      });
      await page.waitForTimeout(100);

      expect(socketError).toBeNull();
    });
  });

  it("emits websocket binary frames like Playwright", async () => {
    await withPage(async (page) => {
      server.keepNextConnectionOpen();
      let resolveClosed!: () => void;
      const closedPromise = new Promise<void>((resolve) => {
        resolveClosed = resolve;
      });
      const sent: Array<string | Buffer> = [];

      page.on("websocket", (webSocket) => {
        webSocket.on("framesent", (data) => {
          sent.push(data.payload);
        });
        webSocket.on("close", () => {
          resolveClosed();
        });
      });

      await page.evaluate((url) => {
        const socket = new WebSocket(url);
        socket.addEventListener("open", () => {
          const binary = new Uint8Array(5);
          for (let index = 0; index < 5; index += 1) {
            binary[index] = index;
          }
          socket.send("text");
          socket.send(binary);
          socket.close();
        });
      }, server.url());

      await closedPromise;
      expect(sent[0]).toBe("text");
      expect(Buffer.isBuffer(sent[1])).toBe(true);
      for (let index = 0; index < 5; index += 1) {
        expect((sent[1] as Buffer)[index]).toBe(index);
      }
    });
  });

  it("rejects websocket waiters when the page closes like Playwright", async () => {
    await withPage(async (page) => {
      server.keepNextConnectionOpen();
      const [webSocket] = await Promise.all([
        page.waitForEvent("websocket").then(async (candidate) => {
          await candidate.waitForEvent("framereceived");
          return candidate;
        }),
        page.evaluate((url) => {
          const socket = new WebSocket(url);
          socket.addEventListener("open", () => socket.send("outgoing"));
          window["ws"] = socket;
        }, server.url())
      ]);

      const error = webSocket.waitForEvent("framesent").catch((caught) => caught as Error);
      await page.close();

      expect((await error).message).toContain("Target page, context or browser has been closed");
    });
  });

  it("routes websocket messages on the page and context like Playwright", async () => {
    await withPage(async (page) => {
      await page.routeWebSocket(/ws1/, (ws) => {
        ws.onMessage(() => {
          ws.send("page-mock-1");
        });
      });
      await page.routeWebSocket(/ws1/, (ws) => {
        ws.onMessage(() => {
          ws.send("page-mock-2");
        });
      });
      await page.context().routeWebSocket(/.*/, (ws) => {
        ws.onMessage(() => {
          ws.send("context-mock-1");
        });
        ws.onMessage(() => {
          ws.send("context-mock-2");
        });
      });

      await installLoggedWebSocket(page, `ws://${server.host()}/ws1`, "ws1");
      await page.evaluate(() => {
        window["ws"].send("request");
      });
      await page.waitForFunction(() => window["log"]?.length === 2);
      expect(await page.evaluate(() => window["log"])).toEqual([
        "open",
        "message:page-mock-2"
      ]);

      await installLoggedWebSocket(page, `ws://${server.host()}/ws2`, "ws2");
      await page.evaluate(() => {
        window["ws"].send("request");
      });
      await page.waitForFunction(() => window["log"]?.length === 2);
      expect(await page.evaluate(() => window["log"])).toEqual([
        "open",
        "message:context-mock-2"
      ]);
    });
  });

  it("works without an upstream server route like Playwright", async () => {
    await withPage(async (page) => {
      let routeRef: import("../../../src/types/api.js").WebSocketRoute | null = null;
      await page.routeWebSocket(/.*/, (ws) => {
        ws.onMessage((message) => {
          if (String(message) === "to-respond") {
            ws.send("response");
          }
        });
        routeRef = ws;
      });

      await installLoggedWebSocket(page, `ws://${server.host()}/ws`, "mock");
      await page.evaluate(async () => {
        window["ws"].send("to-respond");
        window["ws"].send("to-block");
        window["ws"].send("to-respond");
      });
      await page.waitForFunction(() => window["log"]?.length === 3);
      expect(await page.evaluate(() => window["log"])).toEqual([
        "open",
        "message:response",
        "message:response"
      ]);

      routeRef!.send("another");
      await routeRef!.close({ code: 3008, reason: "oops" });
      await page.waitForFunction(() => window["log"]?.length === 5);
      expect(await page.evaluate(() => window["log"])).toEqual([
        "open",
        "message:response",
        "message:response",
        "message:another",
        "close:3008:oops:true"
      ]);
    });
  });

  it("keeps websocket routes open with an empty handler like Playwright", async () => {
    await withPage(async (page) => {
      await page.routeWebSocket(/.*/, () => {});

      await installLoggedWebSocket(page, `ws://${server.host()}/ws`, "empty");
      await page.evaluate(() => {
        window["ws"].send("hi");
        window["ws"].send("hi2");
      });
      await page.waitForTimeout(100);

      expect(await page.evaluate(() => window["log"])).toEqual(["open"]);
    });
  });

  it("exposes websocket protocols to route handlers like Playwright", async () => {
    await withPage(async (page) => {
      const routes: Array<{ url: string; protocols: string[] }> = [];
      await page.routeWebSocket(/.*/, (ws) => {
        routes.push({
          url: ws.url(),
          protocols: ws.protocols()
        });
      });

      await page.setContent("<div>ws protocols</div>");
      await page.evaluate((host) => {
        new WebSocket(`ws://${host}/ws-none`);
        new WebSocket(`ws://${host}/ws-string`, "chat.v1");
        new WebSocket(`ws://${host}/ws-array`, ["chat.v2", "chat.v1"]);
      }, server.host());

      await expect.poll(() => routes.length).toBe(3);
      expect(routes).toEqual([
        { url: `ws://${server.host()}/ws-none`, protocols: [] },
        { url: `ws://${server.host()}/ws-string`, protocols: ["chat.v1"] },
        { url: `ws://${server.host()}/ws-array`, protocols: ["chat.v2", "chat.v1"] }
      ]);
    });
  });
});

async function installLoggedWebSocket(
  page: Awaited<ReturnType<typeof withPage>> extends never ? never : any,
  url: string,
  tag: string
): Promise<void> {
  await page.setContent(`<div>${tag}</div>`);
  await page.evaluate((socketUrl) => {
    window["log"] = [];
    const socket = new WebSocket(socketUrl);
    socket.addEventListener("open", () => {
      window["log"].push("open");
    });
    socket.addEventListener("message", (event) => {
      window["log"].push(`message:${String(event.data)}`);
    });
    socket.addEventListener("close", (event) => {
      window["log"].push(`close:${event.code}:${event.reason}:${event.wasClean}`);
    });
    window["ws"] = socket;
    window["wsOpened"] = new Promise((resolve) => {
      socket.addEventListener("open", () => resolve(undefined), { once: true });
    });
  }, url);
  await page.evaluate(() => window["wsOpened"]);
}

class MinimalWebSocketServer {
  private autoCloseAfterFirstMessage = true;
  private nextConnectionCloseFrame: Buffer | null = null;
  private nextConnectionInitialMessage: string | null = null;
  private readonly server: Server;
  private sockets = new Set<Socket>();

  private constructor(server: Server, private readonly port: number) {
    this.server = server;
  }

  static async create(): Promise<MinimalWebSocketServer> {
    const httpServer = createServer();
    const server = new MinimalWebSocketServer(httpServer, await listen(httpServer));
    httpServer.on("upgrade", (request, socket) => {
      if (request.url !== "/ws") {
        socket.write(
          "HTTP/1.1 400 Bad Request\r\n" +
            "Connection: close\r\n" +
            "Content-Length: 0\r\n" +
            "\r\n"
        );
        socket.destroy();
        return;
      }
      server.sockets.add(socket);
      socket.on("close", () => server.sockets.delete(socket));
      const key = request.headers["sec-websocket-key"];
      if (typeof key !== "string") {
        socket.destroy();
        return;
      }
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n` +
          "\r\n"
      );
      const initialMessage = server.nextConnectionInitialMessage;
      server.nextConnectionInitialMessage = null;
      if (initialMessage !== null) {
        socket.write(encodeTextFrame(initialMessage));
      }
      socket.once("data", () => {
        if (initialMessage === null) {
          if (!socket.destroyed && socket.writable) {
            socket.write(encodeTextFrame("incoming"));
          }
        }
        if (server.nextConnectionCloseFrame) {
          if (!socket.destroyed && socket.writable) {
            socket.write(server.nextConnectionCloseFrame);
            socket.end();
          }
          server.nextConnectionCloseFrame = null;
        } else if (server.autoCloseAfterFirstMessage) {
          setTimeout(() => {
            if (!socket.destroyed && socket.writable) {
              socket.write(Buffer.from([0x88, 0x00]));
            }
          }, 50);
        }
        server.autoCloseAfterFirstMessage = true;
      });
      socket.on("data", (data) => {
        if (!containsCloseFrame(data)) {
          return;
        }
        if (!socket.destroyed && socket.writable) {
          socket.write(Buffer.from([0x88, 0x00]));
          socket.end();
        }
      });
    });
    return server;
  }

  url(): string {
    return `ws://127.0.0.1:${this.port}/ws`;
  }

  host(): string {
    return `127.0.0.1:${this.port}`;
  }

  badUrl(): string {
    return `ws://127.0.0.1:${this.port}/bogus-ws`;
  }

  keepNextConnectionOpen(): void {
    this.autoCloseAfterFirstMessage = false;
  }

  sendOnNextConnection(message: string): void {
    this.nextConnectionInitialMessage = message;
  }

  closeNextConnectionOnFirstMessage(code: number, reason: string): void {
    this.autoCloseAfterFirstMessage = false;
    this.nextConnectionCloseFrame = encodeCloseFrame(code, reason);
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}

function acceptKey(key: string): string {
  return createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
}

function encodeTextFrame(text: string): Buffer {
  const payload = Buffer.from(text);
  return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
}

function encodeCloseFrame(code: number, reason: string): Buffer {
  const reasonBytes = Buffer.from(reason);
  const payload = Buffer.alloc(2 + reasonBytes.length);
  payload.writeUInt16BE(code, 0);
  reasonBytes.copy(payload, 2);
  return Buffer.concat([Buffer.from([0x88, payload.length]), payload]);
}

function containsCloseFrame(data: Buffer): boolean {
  let offset = 0;

  while (offset + 2 <= data.length) {
    const firstByte = data[offset];
    const secondByte = data[offset + 1];
    if (firstByte === undefined || secondByte === undefined) {
      return false;
    }

    const opcode = firstByte & 0x0f;
    const masked = (secondByte & 0x80) !== 0;
    let payloadLength = secondByte & 0x7f;
    let cursor = offset + 2;

    if (payloadLength === 126) {
      if (cursor + 2 > data.length) {
        return false;
      }
      payloadLength = data.readUInt16BE(cursor);
      cursor += 2;
    } else if (payloadLength === 127) {
      if (cursor + 8 > data.length) {
        return false;
      }
      const extendedLength = data.readBigUInt64BE(cursor);
      if (extendedLength > BigInt(Number.MAX_SAFE_INTEGER)) {
        return false;
      }
      payloadLength = Number(extendedLength);
      cursor += 8;
    }

    if (masked) {
      cursor += 4;
    }

    const nextOffset = cursor + payloadLength;
    if (nextOffset > data.length) {
      return false;
    }
    if (opcode === 0x08) {
      return true;
    }
    offset = nextOffset;
  }

  return false;
}

async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => {
    server.once("listening", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind websocket test server.");
  }
  return address.port;
}
