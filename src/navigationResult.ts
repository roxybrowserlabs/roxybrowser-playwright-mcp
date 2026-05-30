import type { Header } from "./types/options.js";
import type { PageNavigationResult } from "./types/api.js";

export function createNavigationResult(input: {
  headers?: Header[];
  ok?: boolean;
  status?: number | null;
  statusText?: string | null;
  url: string;
}): PageNavigationResult {
  const headers = input.headers ? [...input.headers] : [];
  const status = input.status ?? null;
  const statusText = input.statusText ?? null;
  const ok = input.ok ?? (status === null ? true : status >= 200 && status < 400);
  const url = input.url;

  return {
    ok: () => ok,
    url: () => url,
    status: () => status,
    statusText: () => statusText,
    headers: () => [...headers]
  };
}
