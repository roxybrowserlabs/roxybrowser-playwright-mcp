import { RoxyBrowserClient } from "@roxybrowser/openapi";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = "50000";

export class RoxyClient {
  constructor(portOrOptions = DEFAULT_PORT, token) {
    const options = typeof portOrOptions === "object" && portOrOptions !== null
      ? portOrOptions
      : { port: portOrOptions, token };

    this.host = options.host ?? DEFAULT_HOST;
    this.port = String(options.port ?? DEFAULT_PORT);
    this.token = options.token ?? options.apiToken ?? options.apiKey ?? "";
    this.url = options.baseUrl ?? `http://${this.host}:${this.port}`;
    this.timeoutMs = Number(
      options.timeoutMs
      ?? process.env.ROXYBROWSER_API_TIMEOUT_MS
      ?? process.env.ROXY_API_TIMEOUT_MS
      ?? process.env.ROXYBROWSER_OPERATION_TIMEOUT_MS
      ?? process.env.ROXY_OPERATION_TIMEOUT_MS
      ?? 15000
    );

    this.sdk = new RoxyBrowserClient({
      baseUrl: this.url,
      apiKey: this.token,
      timeout: this.timeoutMs,
      ...(options.workspaceId !== undefined ? { workspaceId: Number(options.workspaceId) } : {}),
      fetch: this._fetchWithFriendlyTimeout.bind(this)
    });
  }

  set timeoutMs(value) {
    const parsed = Number(value);
    this._timeoutMs = Number.isFinite(parsed) && parsed > 0 ? parsed : 5000;
    if (this.sdk?.api?.transport) {
      this.sdk.api.transport.timeout = this._timeoutMs;
    }
  }

  get timeoutMs() {
    return this._timeoutMs;
  }

  async _fetchWithFriendlyTimeout(url, init) {
    try {
      return await fetch(url, init);
    } catch (error) {
      if (error?.name === "AbortError") {
        throw new Error(`RoxyBrowser API request timed out after ${this.timeoutMs}ms: ${url}`);
      }
      throw error;
    }
  }

  health() {
    return this.sdk.health();
  }

  workspace_project() {
    return this.sdk.api.workspace.list();
  }

  browser_list(workspaceId, filters = "", pageIndex = 1, pageSize = 15) {
    const params = typeof filters === "string"
      ? { workspaceId, sortNums: filters, page_index: pageIndex, page_size: pageSize }
      : { workspaceId, page_index: pageIndex, page_size: pageSize, ...filters };
    return this.sdk.api.browser.list(params);
  }

  browser_detail(workspaceId, dirId) {
    return this.sdk.api.browser.detail({ workspaceId, dirId });
  }

  browser_create(data = {}) {
    return this.sdk.api.browser.create(data);
  }

  browser_mdf(data = {}) {
    return this.sdk.api.browser.modify(data);
  }

  browser_delete(workspaceId, dirId, isSoftDelete = false) {
    return this.sdk.api.browser.delete({
      workspaceId,
      dirIds: [dirId],
      isSoftDelete
    });
  }

  browser_open(dirId, args = [], options = {}) {
    return this.sdk.api.browser.open({
      dirId,
      args,
      ...options
    });
  }

  browser_close(dirId) {
    return this.sdk.api.browser.close({ dirId });
  }

  browser_clear_local_cache(dirId) {
    return this.sdk.api.browser.clearLocalCache({ dirIds: [dirId] });
  }

  browser_clear_server_cache(workspaceId, dirId) {
    return this.sdk.api.browser.clearServerCache({
      workspaceId,
      dirIds: [dirId]
    });
  }

  browser_random_env(workspaceId, dirId) {
    return this.sdk.api.browser.randomEnv({ workspaceId, dirId });
  }

  browser_connection_info(dirIds = "") {
    return this.sdk.api.browser.connectionInfo(dirIds ? { dirIds } : undefined);
  }
}
