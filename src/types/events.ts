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
}

export interface PageRequestFailure {
  url: string;
  method: string;
  errorText: string;
}

export interface PageEventMap {
  close: void;
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
