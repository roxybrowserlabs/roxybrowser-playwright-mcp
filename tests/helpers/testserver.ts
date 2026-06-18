import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { gzip } from "node:zlib";
import { promisify } from "node:util";

type RouteHandler = (
  request: IncomingMessage & { postBody: Promise<Buffer> },
  response: ServerResponse
) => void;

const fulfillSymbol = Symbol("fulfill");
const rejectSymbol = Symbol("reject");
const gzipAsync = promisify(gzip);

type PendingRequest = Promise<IncomingMessage> & {
  [fulfillSymbol]: (request: IncomingMessage) => void;
  [rejectSymbol]: () => void;
};

export class TestServer {
  readonly PORT: number;
  readonly PREFIX: string;
  readonly CROSS_PROCESS_PREFIX: string;
  readonly EMPTY_PAGE: string;
  readonly HOST: string;
  readonly HOSTNAME: string;
  readonly BIND_HOST: string;
  readonly URL_HOSTNAME: string;

  private readonly server = createServer(this.onRequest.bind(this));
  private readonly routes = new Map<string, RouteHandler>();
  private readonly csp = new Map<string, string>();
  private readonly extraHeaders = new Map<string, Record<string, string>>();
  private readonly gzipRoutes = new Set<string>();
  private readonly requestSubscribers = new Map<string, PendingRequest>();

  static async create(assetRoot: string, port = 0): Promise<TestServer> {
    const server = new TestServer(assetRoot, port);
    await server.listen();
    return server;
  }

  private constructor(
    private readonly assetRoot: string,
    port: number
  ) {
    this.server.listen(port, "127.0.0.1");
    this.PORT = port;
    this.PREFIX = "";
    this.CROSS_PROCESS_PREFIX = "";
    this.EMPTY_PAGE = "";
    this.HOST = "";
    this.HOSTNAME = "";
    this.BIND_HOST = "127.0.0.1";
    this.URL_HOSTNAME = "localhost";
  }

  private async listen(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server.once("listening", () => resolve());
    });
    const address = this.server.address();
    if (!address || typeof address === "string") {
      throw new Error("Failed to bind test server.");
    }

    const prefix = `http://${this.URL_HOSTNAME}:${address.port}`;
    const crossProcessPrefix = `http://127.0.0.1:${address.port}`;
    (this as { PORT: number }).PORT = address.port;
    (this as { PREFIX: string }).PREFIX = prefix;
    (this as { CROSS_PROCESS_PREFIX: string }).CROSS_PROCESS_PREFIX = crossProcessPrefix;
    (this as { EMPTY_PAGE: string }).EMPTY_PAGE = `${prefix}/empty.html`;
    (this as { HOST: string }).HOST = new URL(prefix).host;
    (this as { HOSTNAME: string }).HOSTNAME = new URL(prefix).hostname;
  }

  asset(...segments: string[]): string {
    return join(this.assetRoot, ...segments);
  }

  reset(): void {
    this.routes.clear();
    this.csp.clear();
    this.extraHeaders.clear();
    this.gzipRoutes.clear();
    for (const subscriber of this.requestSubscribers.values()) {
      subscriber[rejectSymbol]();
    }
    this.requestSubscribers.clear();
  }

  async stop(): Promise<void> {
    this.reset();
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

  setRoute(path: string, handler: RouteHandler): void {
    this.routes.set(path, handler);
  }

  enableGzip(path: string): void {
    this.gzipRoutes.add(path);
  }

  setCSP(path: string, csp: string): void {
    this.csp.set(path, csp);
  }

  setExtraHeaders(path: string, headers: Record<string, string>): void {
    this.extraHeaders.set(path, headers);
  }

  setRedirect(from: string, to: string): void {
    this.setRoute(from, (request, response) => {
      const headers = this.extraHeaders.get(request.url ?? "") ?? {};
      response.writeHead(302, {
        ...headers,
        location: to
      });
      response.end();
    });
  }

  setContent(path: string, content: string, mimeType: string): void {
    this.setRoute(path, (_request, response) => {
      response.writeHead(200, { "Content-Type": mimeType });
      response.end(mimeType === "text/html" ? `<!DOCTYPE html>${content}` : content);
    });
  }

  waitForRequest(path: string): Promise<IncomingMessage> {
    const existing = this.requestSubscribers.get(path);
    if (existing) {
      return existing;
    }

    let fulfill!: (request: IncomingMessage) => void;
    let reject!: () => void;
    const promise = new Promise<IncomingMessage>((resolve, rejectCallback) => {
      fulfill = resolve;
      reject = () => {
        rejectCallback(new Error(`Request ${path} was not received before the test finished.`));
      };
    }) as PendingRequest;
    promise[fulfillSymbol] = fulfill;
    promise[rejectSymbol] = reject;
    this.requestSubscribers.set(path, promise);
    return promise;
  }

  private onRequest(request: IncomingMessage, response: ServerResponse): void {
    (request as IncomingMessage & { postBody: Promise<Buffer> }).postBody = new Promise((resolve) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => resolve(Buffer.concat(chunks)));
    });

    const url = new URL(request.url ?? "/", `http://${this.URL_HOSTNAME}`);
    const pathWithSearch = url.pathname + url.search;

    const subscriber = this.requestSubscribers.get(pathWithSearch);
    if (subscriber) {
      subscriber[fulfillSymbol](request);
      this.requestSubscribers.delete(pathWithSearch);
    }

    const route = this.routes.get(pathWithSearch);
    if (route) {
      route(request as IncomingMessage & { postBody: Promise<Buffer> }, response);
      return;
    }

    void this.serveAsset(pathWithSearch, response);
  }

  private async serveAsset(pathWithSearch: string, response: ServerResponse): Promise<void> {
    const relativePath = pathWithSearch === "/" ? "index.html" : pathWithSearch.slice(1);
    const filePath = this.asset(relativePath);

    try {
      const body = await readFile(filePath);
      response.statusCode = 200;
      response.setHeader("Content-Type", contentTypeFor(filePath));
      response.setHeader("Cache-Control", "no-cache, no-store");
      const extraHeaders = this.extraHeaders.get(pathWithSearch);
      if (extraHeaders) {
        for (const [name, value] of Object.entries(extraHeaders)) {
          response.setHeader(name, value);
        }
      }
      const csp = this.csp.get(pathWithSearch);
      if (csp !== undefined) {
        response.setHeader("Content-Security-Policy", csp);
      }
      if (this.gzipRoutes.has(pathWithSearch)) {
        response.setHeader("Content-Encoding", "gzip");
        response.end(await gzipAsync(body));
        return;
      }
      response.end(body);
    } catch {
      response.statusCode = 404;
      response.setHeader("Content-Type", "text/plain; charset=utf-8");
      response.end(`File not found: ${filePath}`);
    }
  }
}

function contentTypeFor(filePath: string): string {
  if (filePath.endsWith(".html")) {
    return "text/html; charset=utf-8";
  }
  if (filePath.endsWith(".js")) {
    return "application/javascript; charset=utf-8";
  }
  if (filePath.endsWith(".json")) {
    return "application/json; charset=utf-8";
  }
  if (filePath.endsWith(".css")) {
    return "text/css; charset=utf-8";
  }
  return "application/octet-stream";
}
