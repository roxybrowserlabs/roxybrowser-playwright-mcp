import type { IncomingMessage, IncomingHttpHeaders } from "node:http";
import type { ReadStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { Readable } from "node:stream";
import { writeFile } from "node:fs/promises";
import type {
  APIRequestContext,
  APIRequestFetchOptions,
  APIRequestOptions,
  APIResponse,
  Request
} from "./types/api.js";
import type { FilePayload } from "./types/options.js";

const DEFAULT_TIMEOUT_MS = 30_000;

interface StoredCookie {
  domain: string;
  expires: number;
  hostOnly: boolean;
  httpOnly: boolean;
  name: string;
  path: string;
  sameSite: "Strict" | "Lax" | "None";
  secure: boolean;
  value: string;
}

export class RoxyAPIRequestContext implements APIRequestContext {
  private closedReason: string | null = null;
  private readonly cookies: StoredCookie[] = [];

  async delete(url: string, options?: APIRequestOptions): Promise<APIResponse> {
    return this.fetch(url, {
      ...options,
      method: "DELETE"
    });
  }

  async dispose(options?: { reason?: string }): Promise<void> {
    this.closedReason = options?.reason ?? "APIRequestContext disposed";
  }

  async fetch(
    urlOrRequest: string | Request,
    options: APIRequestFetchOptions = {}
  ): Promise<APIResponse> {
    if (this.closedReason) {
      throw new Error(this.closedReason);
    }

    const sourceRequest = typeof urlOrRequest === "string" ? null : urlOrRequest;
    const method = options.method ?? sourceRequest?.method() ?? "GET";
    const url = appendQueryParams(
      typeof urlOrRequest === "string" ? urlOrRequest : urlOrRequest.url(),
      options.params
    );
    const headers = normalizeHeaders({
      ...(sourceRequest?.headers() ?? {}),
      ...(options.headers ?? {})
    });
    this.applyCookieHeader(url, headers);
    const body = await buildRequestBody(sourceRequest, headers, options);
    const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const timeoutHandle =
      timeout > 0
        ? setTimeout(() => controller.abort(new Error(`Request timed out after ${timeout}ms`)), timeout)
        : null;

    try {
      const response = await fetchWithRetries(url, {
        ...(body ? { body } : {}),
        headers,
        method,
        signal: controller.signal,
        ...(options.maxRedirects !== undefined ? { maxRedirects: options.maxRedirects } : {}),
        ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {})
      });
      this.storeResponseCookies(url, response);
      const apiResponse = createApiResponse(response);
      if (options.failOnStatusCode && !(apiResponse.status() >= 200 && apiResponse.status() < 400)) {
        throw new Error(await formatFailOnStatusCodeMessage(apiResponse, method));
      }
      return apiResponse;
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  async get(url: string, options?: APIRequestOptions): Promise<APIResponse> {
    return this.fetch(url, {
      ...options,
      method: "GET"
    });
  }

  async head(url: string, options?: APIRequestOptions): Promise<APIResponse> {
    return this.fetch(url, {
      ...options,
      method: "HEAD"
    });
  }

  async patch(url: string, options?: APIRequestOptions): Promise<APIResponse> {
    return this.fetch(url, {
      ...options,
      method: "PATCH"
    });
  }

  async post(url: string, options?: APIRequestOptions): Promise<APIResponse> {
    return this.fetch(url, {
      ...options,
      method: "POST"
    });
  }

  async put(url: string, options?: APIRequestOptions): Promise<APIResponse> {
    return this.fetch(url, {
      ...options,
      method: "PUT"
    });
  }

  async storageState(options?: { indexedDB?: boolean; path?: string }): Promise<{
    cookies: Array<{
      name: string;
      value: string;
      domain: string;
      path: string;
      expires: number;
      httpOnly: boolean;
      secure: boolean;
      sameSite: "Strict" | "Lax" | "None";
    }>;
    origins: Array<{
      origin: string;
      localStorage: Array<{
        name: string;
        value: string;
      }>;
    }>;
  }> {
    const state = {
      cookies: this.cookies.map((cookie) => ({
        domain: cookie.domain,
        expires: cookie.expires,
        httpOnly: cookie.httpOnly,
        name: cookie.name,
        path: cookie.path,
        sameSite: cookie.sameSite,
        secure: cookie.secure,
        value: cookie.value
      })),
      origins: []
    };
    if (options?.path) {
      await mkdir(dirname(options.path), { recursive: true });
      await writeFile(options.path, JSON.stringify(state, null, 2));
    }
    return state;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.dispose();
  }

  private applyCookieHeader(url: string, headers: Record<string, string>): void {
    if (hasExplicitHeader(headers, "cookie")) {
      return;
    }
    const cookies = this.cookiesForUrl(url);
    if (!cookies.length) {
      return;
    }
    headers.cookie = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
  }

  private cookiesForUrl(url: string): StoredCookie[] {
    const parsedUrl = new URL(url);
    const now = Math.floor(Date.now() / 1000);
    return this.cookies.filter((cookie) => {
      if (cookie.expires !== -1 && cookie.expires <= now) {
        return false;
      }
      if (cookie.secure && !isSecureRequest(parsedUrl, cookie)) {
        return false;
      }
      if (!domainMatches(parsedUrl.hostname, cookie)) {
        return false;
      }
      return pathMatches(parsedUrl.pathname, cookie.path);
    });
  }

  private storeResponseCookies(url: string, response: globalThis.Response): void {
    for (const header of extractSetCookieHeaders(response)) {
      const parsedCookie = parseSetCookieHeader(url, header);
      if (!parsedCookie) {
        continue;
      }
      const index = this.cookies.findIndex(
        (cookie) =>
          cookie.name === parsedCookie.name &&
          cookie.domain === parsedCookie.domain &&
          cookie.path === parsedCookie.path
      );
      if (parsedCookie.expires !== -1 && parsedCookie.expires <= 0) {
        if (index >= 0) {
          this.cookies.splice(index, 1);
        }
        continue;
      }
      if (index >= 0) {
        this.cookies[index] = parsedCookie;
      } else {
        this.cookies.push(parsedCookie);
      }
    }
  }
}

function appendQueryParams(
  url: string,
  params?: { [key: string]: string | number | boolean } | URLSearchParams | string
): string {
  if (params === undefined) {
    return url;
  }

  const parsed = new URL(url);
  if (typeof params === "string") {
    parsed.search = params.startsWith("?") ? params.slice(1) : params;
    return parsed.toString();
  }
  if (params instanceof URLSearchParams) {
    parsed.search = params.toString();
    return parsed.toString();
  }

  const searchParams = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) {
    searchParams.append(name, String(value));
  }
  parsed.search = searchParams.toString();
  return parsed.toString();
}

function normalizeHeaders(
  headers: Record<string, string | undefined>
): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) {
      continue;
    }
    normalized[name.toLowerCase()] = String(value);
  }
  return normalized;
}

function hasExplicitHeader(headers: Record<string, string>, name: string): boolean {
  const normalizedName = name.toLowerCase();
  return Object.keys(headers).some((headerName) => headerName.toLowerCase() === normalizedName);
}

async function buildRequestBody(
  sourceRequest: Request | null,
  headers: Record<string, string>,
  options: APIRequestFetchOptions
): Promise<Buffer | undefined> {
  const specifiedBodies = [options.data, options.form, options.multipart].filter(
    (value) => value !== undefined
  ).length;
  if (specifiedBodies > 1) {
    throw new Error("Only one of 'data', 'form' or 'multipart' can be specified");
  }

  if (options.data !== undefined) {
    if (Buffer.isBuffer(options.data)) {
      headers["content-type"] ??= "application/octet-stream";
      return withContentLength(headers, Buffer.from(options.data));
    }
    if (typeof options.data === "string") {
      headers["content-type"] ??= "application/octet-stream";
      return withContentLength(headers, Buffer.from(options.data, "utf8"));
    }
    headers["content-type"] ??= "application/json";
    return withContentLength(headers, Buffer.from(JSON.stringify(options.data), "utf8"));
  }

  if (options.form !== undefined) {
    headers["content-type"] ??= "application/x-www-form-urlencoded";
    if (typeof FormData !== "undefined" && options.form instanceof FormData) {
      const searchParams = new URLSearchParams();
      for (const [name, value] of options.form.entries()) {
        if (typeof value !== "string") {
          throw new Error(
            `Expected string for options.form[\"${name}\"], found File. Please use options.multipart instead.`
          );
        }
        searchParams.append(name, value);
      }
      return withContentLength(headers, Buffer.from(searchParams.toString(), "utf8"));
    }
    const searchParams = new URLSearchParams();
    for (const [name, value] of Object.entries(options.form)) {
      searchParams.append(name, String(value));
    }
    return withContentLength(headers, Buffer.from(searchParams.toString(), "utf8"));
  }

  if (options.multipart !== undefined) {
    const boundary = `----roxy${Math.random().toString(16).slice(2)}`;
    headers["content-type"] ??= `multipart/form-data; boundary=${boundary}`;
    return withContentLength(headers, await serializeMultipartBody(boundary, options.multipart));
  }

  const fallbackBody = sourceRequest?.postDataBuffer() ?? undefined;
  return fallbackBody ? withContentLength(headers, Buffer.from(fallbackBody)) : undefined;
}

async function serializeMultipartBody(
  boundary: string,
  multipart:
    | FormData
    | {
        [key: string]:
          | string
          | number
          | boolean
          | ReadStream
          | FilePayload;
      }
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const appendTextField = (name: string, value: string) => {
    chunks.push(Buffer.from(`--${boundary}\r\n`, "utf8"));
    chunks.push(
      Buffer.from(`Content-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`, "utf8")
    );
  };
  const appendFileField = (name: string, file: FilePayload) => {
    chunks.push(Buffer.from(`--${boundary}\r\n`, "utf8"));
    chunks.push(
      Buffer.from(
        `Content-Disposition: form-data; name="${name}"; filename="${file.name}"\r\n` +
          `Content-Type: ${file.mimeType}\r\n\r\n`,
        "utf8"
      )
    );
    chunks.push(Buffer.from(file.buffer));
    chunks.push(Buffer.from("\r\n", "utf8"));
  };

  if (typeof FormData !== "undefined" && multipart instanceof FormData) {
    for (const [name, value] of multipart.entries()) {
      if (typeof value === "string") {
        appendTextField(name, value);
      } else {
        appendFileField(name, await blobLikeToFilePayload(value));
      }
    }
  } else {
    for (const [name, value] of Object.entries(multipart)) {
      if (isFilePayload(value)) {
        appendFileField(name, value);
      } else if (isReadStream(value)) {
        appendFileField(name, await readStreamToFilePayload(value));
      } else {
        appendTextField(name, String(value));
      }
    }
  }

  chunks.push(Buffer.from(`--${boundary}--\r\n`, "utf8"));
  return Buffer.concat(chunks);
}

function isFilePayload(value: unknown): value is FilePayload {
  return Boolean(
    value &&
      typeof value === "object" &&
      "name" in value &&
      "mimeType" in value &&
      "buffer" in value
  );
}

function isReadStream(value: unknown): value is ReadStream {
  return value instanceof Readable;
}

function extractSetCookieHeaders(response: globalThis.Response): string[] {
  if ("getSetCookie" in response.headers && typeof response.headers.getSetCookie === "function") {
    return response.headers.getSetCookie();
  }
  const value = response.headers.get("set-cookie");
  if (!value) {
    return [];
  }
  return splitSetCookieHeader(value);
}

function parseSetCookieHeader(url: string, header: string): StoredCookie | null {
  const parsedUrl = new URL(url);
  const [nameValue, ...attributeParts] = header.split(";");
  if (!nameValue) {
    return null;
  }
  const separatorIndex = nameValue.indexOf("=");
  if (separatorIndex < 0) {
    return null;
  }

  const name = nameValue.slice(0, separatorIndex).trim();
  const value = nameValue.slice(separatorIndex + 1).trim();
  let domain = parsedUrl.hostname;
  let hostOnly = true;
  let path = "/";
  let expires = -1;
  let httpOnly = false;
  let secure = false;
  let sameSite: "Strict" | "Lax" | "None" = "Lax";

  for (const rawAttribute of attributeParts) {
    const attribute = rawAttribute.trim();
    const attributeSeparatorIndex = attribute.indexOf("=");
    const attributeName =
      attributeSeparatorIndex >= 0
        ? attribute.slice(0, attributeSeparatorIndex).trim().toLowerCase()
        : attribute.toLowerCase();
    const attributeValue =
      attributeSeparatorIndex >= 0 ? attribute.slice(attributeSeparatorIndex + 1).trim() : "";

    if (attributeName === "domain" && attributeValue) {
      hostOnly = false;
      domain = attributeValue.startsWith(".") ? attributeValue : `.${attributeValue}`;
      continue;
    }
    if (attributeName === "path" && attributeValue) {
      path = attributeValue;
      continue;
    }
    if (attributeName === "expires" && attributeValue) {
      const parsedExpires = Date.parse(attributeValue);
      expires = Number.isNaN(parsedExpires) ? -1 : Math.floor(parsedExpires / 1000);
      continue;
    }
    if (attributeName === "max-age" && attributeValue) {
      const maxAge = Number(attributeValue);
      expires = Number.isFinite(maxAge) ? (maxAge <= 0 ? 0 : Math.floor(Date.now() / 1000) + maxAge) : expires;
      continue;
    }
    if (attributeName === "httponly") {
      httpOnly = true;
      continue;
    }
    if (attributeName === "secure") {
      secure = true;
      continue;
    }
    if (attributeName === "samesite" && attributeValue) {
      const normalizedSameSite = attributeValue.toLowerCase();
      if (normalizedSameSite === "strict") {
        sameSite = "Strict";
      } else if (normalizedSameSite === "none") {
        sameSite = "None";
      } else {
        sameSite = "Lax";
      }
    }
  }

  return {
    domain,
    expires,
    hostOnly,
    httpOnly,
    name,
    path,
    sameSite,
    secure,
    value
  };
}

function domainMatches(hostname: string, cookie: StoredCookie): boolean {
  if (cookie.hostOnly) {
    return hostname === cookie.domain;
  }
  const normalizedDomain = cookie.domain.startsWith(".") ? cookie.domain.slice(1) : cookie.domain;
  return hostname === normalizedDomain || hostname.endsWith(`.${normalizedDomain}`);
}

function pathMatches(requestPath: string, cookiePath: string): boolean {
  return requestPath === cookiePath || requestPath.startsWith(cookiePath.endsWith("/") ? cookiePath : `${cookiePath}/`) || cookiePath === "/";
}

function isSecureRequest(url: URL, cookie: StoredCookie): boolean {
  if (url.protocol === "https:") {
    return true;
  }
  if (!cookie.secure) {
    return true;
  }
  return url.hostname === "localhost" || url.hostname === "127.0.0.1";
}

async function blobLikeToFilePayload(value: Blob): Promise<FilePayload> {
  const maybeFile = value as Blob & { name?: string };
  return {
    name: maybeFile.name && maybeFile.name.length > 0 ? maybeFile.name : "blob",
    mimeType: value.type || "application/octet-stream",
    buffer: Buffer.from(await value.arrayBuffer())
  };
}

async function readStreamToFilePayload(stream: ReadStream): Promise<FilePayload> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const path = typeof stream.path === "string" ? stream.path : "";
  return {
    name: path ? basename(path) : "file",
    mimeType: inferMimeType(path),
    buffer: Buffer.concat(chunks)
  };
}

function inferMimeType(path: string): string {
  const normalized = path.toLowerCase();
  if (normalized.endsWith(".json")) {
    return "application/json";
  }
  if (normalized.endsWith(".txt")) {
    return "text/plain";
  }
  if (normalized.endsWith(".js")) {
    return "text/javascript";
  }
  if (normalized.endsWith(".png")) {
    return "image/png";
  }
  return "application/octet-stream";
}

function withContentLength(
  headers: Record<string, string>,
  body: Buffer
): Buffer {
  headers["content-length"] ??= String(body.byteLength);
  return body;
}

async function formatFailOnStatusCodeMessage(
  response: APIResponse,
  method: string
): Promise<string> {
  let message = `Request failed with status code ${response.status()} ${response.statusText()}`;
  if (method.toUpperCase() !== "HEAD") {
    const responseText = await response.text().catch(() => "");
    if (responseText) {
      message += `\nResponse text:\n${responseText}`;
    }
  }
  return message;
}

export function createApiResponse(fetchResponse: globalThis.Response): APIResponse {
  const headerEntries = collectFetchHeaderEntries(fetchResponse);
  const headers = aggregateHeaders(headerEntries);
  let bodyPromise: Promise<Buffer> | null = null;
  let disposed = false;

  const readBody = async (): Promise<Buffer> => {
    if (disposed) {
      throw new Error("Response has been disposed");
    }
    bodyPromise ??= fetchResponse
      .clone()
      .arrayBuffer()
      .then((buffer) => Buffer.from(buffer));
    return Buffer.from(await bodyPromise);
  };

  const dispose = async (): Promise<void> => {
    disposed = true;
    bodyPromise = Promise.resolve(Buffer.alloc(0));
  };

  return {
    body: readBody,
    dispose,
    headers: () => ({ ...headers }),
    headersArray: () => headerEntries.map((header) => ({ ...header })),
    json: async () => JSON.parse((await readBody()).toString("utf8")),
    ok: () => fetchResponse.ok,
    securityDetails: async () => null,
    serverAddr: async () => null,
    status: () => fetchResponse.status,
    statusText: () => fetchResponse.statusText,
    text: async () => (await readBody()).toString("utf8"),
    url: () => fetchResponse.url,
    [Symbol.asyncDispose]: dispose
  };
}

export async function fetchWithRetries(
  url: string,
  options: {
    allowGetOrHeadBody?: boolean;
    body?: Buffer;
    headers: Record<string, string>;
    maxRedirects?: number;
    maxRetries?: number;
    method: string;
    signal?: AbortSignal;
  }
): Promise<globalThis.Response> {
  const maxRetries = options.maxRetries ?? 0;
  let attempt = 0;
  for (;;) {
    try {
      return await fetchWithRedirects(url, options);
    } catch (error) {
      if (!shouldRetryFetch(error) || attempt >= maxRetries) {
        throw error;
      }
      attempt += 1;
    }
  }
}

async function fetchWithRedirects(
  url: string,
  options: {
    allowGetOrHeadBody?: boolean;
    body?: Buffer;
    headers: Record<string, string>;
    maxRedirects?: number;
    maxRetries?: number;
    method: string;
    signal?: AbortSignal;
  }
): Promise<globalThis.Response> {
  const maxRedirects = options.maxRedirects ?? 20;
  let currentUrl = url;
  let redirects = 0;

  for (;;) {
    const response =
      options.body &&
      options.allowGetOrHeadBody &&
      (options.method.toUpperCase() === "GET" || options.method.toUpperCase() === "HEAD")
        ? await fetchWithNodeHttp(currentUrl, options)
        : await fetch(currentUrl, {
            ...(options.body ? { body: Buffer.from(options.body) } : {}),
            headers: options.headers,
            method: options.method,
            redirect: "manual",
            ...(options.signal ? { signal: options.signal } : {})
          });
    if (!isRedirectStatus(response.status) || maxRedirects === 0) {
      return response;
    }
    if (redirects >= maxRedirects) {
      throw new Error(`Max redirect count exceeded: ${maxRedirects}`);
    }
    const location = response.headers.get("location");
    if (!location) {
      return response;
    }
    currentUrl = new URL(location, currentUrl).toString();
    redirects += 1;
  }
}

async function fetchWithNodeHttp(
  url: string,
  options: {
    body?: Buffer;
    headers: Record<string, string>;
    method: string;
    signal?: AbortSignal;
  }
): Promise<globalThis.Response> {
  const { request } = await import(new URL(url).protocol === "https:" ? "node:https" : "node:http");
  return await new Promise<globalThis.Response>((resolve, reject) => {
    const parsed = new URL(url);
    const req = request(
      parsed,
      {
        headers: options.headers,
        method: options.method
      },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)));
        res.on("end", () => {
          resolve(
            new Response(Buffer.concat(chunks), {
              headers: normalizeNodeResponseHeaders(res.headers),
              status: res.statusCode ?? 200,
              statusText: res.statusMessage ?? ""
            })
          );
        });
      }
    );
    req.on("error", reject);
    const onAbort = () => {
      req.destroy(new Error("Request aborted"));
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    req.on("close", () => options.signal?.removeEventListener("abort", onAbort));
    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

function normalizeNodeResponseHeaders(headers: IncomingHttpHeaders): HeadersInit {
  const normalized = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        normalized.append(name, entry);
      }
      continue;
    }
    normalized.set(name, value);
  }
  return normalized;
}

function collectFetchHeaderEntries(
  response: globalThis.Response
): Array<{ name: string; value: string }> {
  if ("getSetCookie" in response.headers && typeof response.headers.getSetCookie === "function") {
    const headerEntries: Array<{ name: string; value: string }> = [];
    response.headers.forEach((value, name) => {
      if (name.toLowerCase() === "set-cookie") {
        return;
      }
      headerEntries.push({ name, value });
    });
    for (const cookie of response.headers.getSetCookie()) {
      headerEntries.push({ name: "set-cookie", value: cookie });
    }
    return headerEntries;
  }

  const headerEntries: Array<{ name: string; value: string }> = [];
  response.headers.forEach((value, name) => {
    if (name.toLowerCase() === "set-cookie") {
      for (const cookie of splitSetCookieHeader(value)) {
        headerEntries.push({ name, value: cookie });
      }
      return;
    }
    headerEntries.push({ name, value });
  });
  return headerEntries;
}

function aggregateHeaders(
  headers: Array<{ name: string; value: string }>
): Record<string, string> {
  const normalized: Record<string, string[]> = {};
  for (const header of headers) {
    const name = header.name.toLowerCase();
    normalized[name] ??= [];
    normalized[name]!.push(header.value);
  }
  return Object.fromEntries(
    Object.entries(normalized).map(([name, values]) => [
      name,
      values.join(name === "set-cookie" ? "\n" : ", ")
    ])
  );
}

function splitSetCookieHeader(value: string): string[] {
  return value
    .split("\n")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function shouldRetryFetch(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const errorCode =
    "code" in error && typeof (error as Error & { code?: unknown }).code === "string"
      ? (error as Error & { code: string }).code
      : "cause" in error &&
          error.cause &&
          typeof error.cause === "object" &&
          "code" in (error.cause as Record<string, unknown>) &&
          typeof (error.cause as Record<string, unknown>).code === "string"
        ? ((error.cause as Record<string, unknown>).code as string)
        : null;
  return errorCode === "ECONNRESET";
}

function isRedirectStatus(status: number): boolean {
  return status >= 300 && status < 400;
}
