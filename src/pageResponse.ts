import type { PageResponse } from "./types/events.js";
import type { Header } from "./types/options.js";

export function createPageResponse(input: {
  fromCache: boolean;
  fromServiceWorker?: boolean;
  frameId?: string | null;
  headers: Header[];
  isNavigationRequest?: boolean;
  mimeType: string;
  requestId?: string;
  resourceType?: string;
  status: number;
  statusText: string;
  body?: () => Promise<Buffer>;
  text: () => Promise<string>;
  url: string;
}): PageResponse {
  const headers = [...input.headers];

  return {
    fromCache: input.fromCache,
    ...(input.fromServiceWorker !== undefined
      ? { fromServiceWorker: input.fromServiceWorker }
      : {}),
    ...(input.frameId !== undefined ? { frameId: input.frameId } : {}),
    headers,
    ...(input.isNavigationRequest !== undefined
      ? { isNavigationRequest: input.isNavigationRequest }
      : {}),
    mimeType: input.mimeType,
    ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
    ...(input.resourceType !== undefined ? { resourceType: input.resourceType } : {}),
    status: input.status,
    statusText: input.statusText,
    ...(input.body ? { body: input.body } : {}),
    text: input.text,
    url: input.url
  };
}
