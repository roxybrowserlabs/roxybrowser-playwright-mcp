import type { Header } from "./options.js";

export interface PageRequest {
  url: string;
  method: string;
  headers: Header[];
}

export interface PageResponse {
  url: string;
  status: number;
  statusText: string;
  headers: Header[];
  mimeType: string;
  fromCache: boolean;
  text(): Promise<string>;
}

export interface PageRequestFailure {
  url: string;
  method: string;
  errorText: string;
}

export interface PageConsoleMessage {
  text(): string;
  type(): string;
}

export interface PageEventMap {
  close: void;
  console: PageConsoleMessage;
  domcontentloaded: void;
  load: void;
  request: PageRequest;
  requestfailed: PageRequestFailure;
  response: PageResponse;
}

export type PageEventName = keyof PageEventMap;

export type PageEventListener<K extends PageEventName> = PageEventMap[K] extends void
  ? () => void
  : (payload: PageEventMap[K]) => void;

export type PageEventPredicate<K extends PageEventName> = (
  payload: PageEventMap[K]
) => boolean | Promise<boolean>;
