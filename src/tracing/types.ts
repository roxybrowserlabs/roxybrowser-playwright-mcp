import type { APIResponse, BrowserContext, Page, Request } from "../types/api.js";
import type { InternalRequestFinishedEvent } from "../types/events.js";

export type Header = { name: string; value: string };

export type TraceablePage = Page & {
  attachInternalListener<K extends "request" | "requestfailed">(
    event: K,
    listener: (request: Request) => Promise<void> | void
  ): () => void;
  attachInternalRequestFinishedListener(
    listener: (event: InternalRequestFinishedEvent) => Promise<void> | void
  ): () => void;
};

export type HarOptions = {
  content?: "omit" | "embed" | "attach";
  mode?: "full" | "minimal";
  resourcesDir?: string;
  urlFilter?: string | RegExp;
};

export type TraceOptions = {
  live?: boolean;
  name?: string;
  screenshots?: boolean;
  snapshots?: boolean;
  sources?: boolean;
  title?: string;
};

export type TraceEntry = { name: string; value: string };

export type TraceChunk = {
  events: Array<Record<string, unknown>>;
  name: string;
  networkFile: string;
  options: TraceOptions;
  traceFile: string;
  tracesDir: string;
};

export type APIRequestTraceRecord = {
  apiName: string;
  body?: Buffer;
  error?: Error;
  method: string;
  requestHeaders: Record<string, string>;
  response?: APIResponse;
  responseBody?: Buffer;
  startedAt: number;
  url: string;
};

export type NetworkRecord = {
  body: Buffer;
  method: string;
  requestHeaders: Header[];
  responseHeaders: Header[];
  status: number;
  statusText: string;
  time: number;
  url: string;
};

export type PendingPageRequest = {
  request: Request;
  startedAt: number;
};

export type StackFrame = {
  file: string;
  line?: number;
  column?: number;
};

export type ClientSideCallMetadata = {
  id: string;
  stack?: StackFrame[];
};

export type LocalUtilsZipParams = {
  additionalSources: string[];
  entries: TraceEntry[];
  includeSources: boolean;
  mode: "write" | "append";
  stacksId?: string;
  zipFile: string;
};

export type LocalUtilsTracingStartedParams = {
  live?: boolean;
  traceName: string;
  tracesDir?: string;
};

export type BrowserContextLike = BrowserContext;
