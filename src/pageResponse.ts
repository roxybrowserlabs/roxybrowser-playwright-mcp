import type { PageResponse } from "./types/events.js";
import type { Header } from "./types/options.js";

export function createPageResponse(input: {
  fromCache: boolean;
  headers: Header[];
  mimeType: string;
  status: number;
  statusText: string;
  text: () => Promise<string>;
  url: string;
}): PageResponse {
  const headers = [...input.headers];

  return {
    fromCache: input.fromCache,
    headers,
    mimeType: input.mimeType,
    status: input.status,
    statusText: input.statusText,
    text: input.text,
    url: input.url
  };
}
