import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { calculateSha1, writeZipFile } from "./zip.js";
import type { HarOptions, Header, NetworkRecord, TraceEntry } from "./types.js";

type HarPage = {
  id: string;
  startedDateTime: string;
  title: string;
};

type HarEntry = {
  body: Buffer;
  method: string;
  requestHeaders: Header[];
  responseHeaders: Header[];
  startedDateTime: string;
  status: number;
  statusText: string;
  time: number;
  url: string;
};

export class HarRecorder {
  private readonly entries: HarEntry[] = [];
  private readonly pages: HarPage[] = [];
  readonly options: Required<Pick<HarOptions, "content" | "mode">> & Pick<HarOptions, "resourcesDir" | "urlFilter">;

  constructor(readonly path: string, options: HarOptions = {}) {
    this.options = {
      content: options.content ?? (path.endsWith(".zip") ? "attach" : "embed"),
      mode: options.mode ?? "full",
      ...(options.resourcesDir !== undefined ? { resourcesDir: options.resourcesDir } : {}),
      ...(options.urlFilter !== undefined ? { urlFilter: options.urlFilter } : {})
    };
  }

  addPage(page: HarPage): void {
    if (this.pages.some((entry) => entry.id === page.id)) {
      return;
    }
    this.pages.push(page);
  }

  addEntry(record: NetworkRecord): void {
    this.entries.push({
      body: record.body,
      method: record.method,
      requestHeaders: record.requestHeaders,
      responseHeaders: record.responseHeaders,
      startedDateTime: new Date(Date.now() - record.time).toISOString(),
      status: record.status,
      statusText: record.statusText,
      time: record.time,
      url: record.url
    });
  }

  async export(mode: "entries" | "archive" = "entries"): Promise<{ entries?: TraceEntry[] }> {
    void mode;
    await this.write();
    return { entries: [{ name: "har.har", value: this.path }] };
  }

  async write(): Promise<void> {
    const resources = new Map<string, Buffer>();
    const har = {
      log: {
        version: "1.2",
        creator: {
          name: "Playwright",
          version: "1.61.1"
        },
        pages: this.pages.map((page) => ({
          startedDateTime: page.startedDateTime,
          id: page.id,
          title: page.title,
          pageTimings: {}
        })),
        entries: this.entries.map((entry) => this.harEntry(entry, resources))
      }
    };
    const harBuffer = Buffer.from(JSON.stringify(har, null, 2));
    if (this.path.endsWith(".zip")) {
      await writeZipFile(this.path, [
        { name: "har.har", body: harBuffer },
        ...Array.from(resources.entries()).map(([name, body]) => ({ name, body }))
      ]);
      return;
    }
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, harBuffer);
    if (this.options.resourcesDir) {
      await mkdir(this.options.resourcesDir, { recursive: true });
      await Promise.all(
        Array.from(resources.entries()).map(([name, body]) =>
          writeFile(join(this.options.resourcesDir!, name), body)
        )
      );
    }
  }

  private harEntry(entry: HarEntry, resources: Map<string, Buffer>): Record<string, unknown> {
    const bodySize = this.options.mode === "minimal" ? -1 : entry.body.byteLength;
    return {
      startedDateTime: entry.startedDateTime,
      time: entry.time,
      request: {
        method: entry.method,
        url: entry.url,
        httpVersion: "HTTP/1.1",
        cookies: [],
        headers: entry.requestHeaders,
        queryString: queryString(entry.url),
        headersSize: -1,
        bodySize
      },
      response: {
        status: entry.status,
        statusText: entry.statusText,
        httpVersion: "HTTP/1.1",
        cookies: [],
        headers: entry.responseHeaders,
        content: this.harContent(entry, resources),
        redirectURL: headerValue(entry.responseHeaders, "location") ?? "",
        headersSize: -1,
        bodySize
      },
      cache: {},
      timings: {
        send: 0,
        wait: entry.time,
        receive: 0
      }
    };
  }

  private harContent(entry: HarEntry, resources: Map<string, Buffer>): Record<string, unknown> {
    const mimeType = headerValue(entry.responseHeaders, "content-type") ?? "application/octet-stream";
    if (this.options.content === "omit") {
      return { size: entry.body.byteLength, mimeType };
    }
    if (this.options.content === "attach") {
      const sha1 = calculateSha1(entry.body);
      resources.set(sha1, entry.body);
      return { size: entry.body.byteLength, mimeType, _file: sha1 };
    }
    return {
      size: entry.body.byteLength,
      mimeType,
      text: entry.body.toString("utf8")
    };
  }
}

function headerValue(headers: Header[], name: string): string | null {
  const lower = name.toLowerCase();
  return headers.find((header) => header.name.toLowerCase() === lower)?.value ?? null;
}

function queryString(url: string): Header[] {
  try {
    return Array.from(new URL(url).searchParams.entries()).map(([name, value]) => ({ name, value }));
  } catch {
    return [];
  }
}
