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
});

class MinimalWebSocketServer {
  private autoCloseAfterFirstMessage = true;
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
      socket.once("data", () => {
        socket.write(encodeTextFrame("incoming"));
        if (server.autoCloseAfterFirstMessage) {
          setTimeout(() => {
            if (!socket.destroyed) {
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
        if (!socket.destroyed) {
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

  badUrl(): string {
    return `ws://127.0.0.1:${this.port}/bogus-ws`;
  }

  keepNextConnectionOpen(): void {
    this.autoCloseAfterFirstMessage = false;
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
