import type { Dialog, FileChooser, Frame, JSHandle, Page, Request, Response, Worker } from "./api.js";
import type { Header } from "./options.js";

export interface PageRequest {
  url: string;
  method: string;
  headers: Header[];
  postData?: string | null;
  postDataBufferBase64?: string | null;
  requestId?: string;
  frameId?: string | null;
  resourceType?: string;
  isNavigationRequest?: boolean;
}

export interface PageResponse {
  url: string;
  status: number;
  statusText: string;
  headers: Header[];
  mimeType: string;
  fromCache: boolean;
  fromServiceWorker?: boolean;
  requestId?: string;
  frameId?: string | null;
  resourceType?: string;
  isNavigationRequest?: boolean;
  body?(): Promise<Buffer>;
  text(): Promise<string>;
}

export interface PageRequestFailure {
  url: string;
  method: string;
  errorText: string;
  requestId?: string;
  frameId?: string | null;
  resourceType?: string;
  isNavigationRequest?: boolean;
}

export interface PageConsoleMessage {
  args(): JSHandle[];
  location(): {
    url: string;
    line: number;
    column: number;
    lineNumber: number;
    columnNumber: number;
  };
  page(): Page | null;
  text(): string;
  timestamp(): number;
  type():
    | "log"
    | "debug"
    | "info"
    | "error"
    | "warning"
    | "dir"
    | "dirxml"
    | "table"
    | "trace"
    | "clear"
    | "startGroup"
    | "startGroupCollapsed"
    | "endGroup"
    | "assert"
    | "profile"
    | "profileEnd"
    | "count"
    | "time"
    | "timeEnd";
  worker(): Worker | null;
}

export interface PageDialog {
  accept(promptText?: string): Promise<void>;
  defaultValue(): string;
  dismiss(): Promise<void>;
  message(): string;
  type(): "alert" | "beforeunload" | "confirm" | "prompt";
}

export interface PageErrorEntry extends Error {
  timestamp?: number;
}

export interface PageNetworkRequest extends PageRequest {
  finished: boolean;
}

export interface ScreencastFrame {
  data: Buffer;
  timestamp: number;
  viewportWidth: number;
  viewportHeight: number;
}

export interface RawPageEventMap {
  close: void;
  console: PageConsoleMessage;
  dialog: PageDialog;
  domcontentloaded: void;
  frameattached: void;
  framedetached: void;
  framenavigated: void;
  load: void;
  pageerror: PageErrorEntry;
  request: PageRequest;
  requestfinished: PageRequest;
  requestfailed: PageRequestFailure;
  response: PageResponse;
  screencastFrame: ScreencastFrame;
}

export interface PageEventMap {
  close: Page;
  console: PageConsoleMessage;
  dialog: Dialog;
  domcontentloaded: Page;
  filechooser: FileChooser;
  frameattached: Frame;
  framedetached: Frame;
  framenavigated: Frame;
  load: Page;
  pageerror: PageErrorEntry;
  popup: Page;
  request: Request;
  requestfinished: Request;
  requestfailed: Request;
  response: Response;
  worker: Worker;
}

export type RawPageEventName = keyof RawPageEventMap;
export type PageEventName = keyof PageEventMap;

export type RawPageEventListener<K extends RawPageEventName> = RawPageEventMap[K] extends void
  ? () => void
  : (payload: RawPageEventMap[K]) => void;

export type PageEventListener<K extends PageEventName> = PageEventMap[K] extends void
  ? () => void
  : (payload: PageEventMap[K]) => void;

export type PageEventPredicate<K extends PageEventName> = (
  payload: PageEventMap[K]
) => boolean | Promise<boolean>;
