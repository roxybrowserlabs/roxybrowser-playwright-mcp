import { resolve } from "node:path";
import { RoxyBrowserContext } from "./browserContext.js";
import { resolveHumanizationOptions } from "./human/profile.js";
import { normalizeExtraHTTPHeaders } from "./httpHeaders.js";
import type {
  ProtocolBrowserAdapter,
  ProtocolBrowserSession
} from "./protocol/adapter.js";
import type { Browser, BrowserContext } from "./types/api.js";
import type { BrowserContextOptions } from "./types/options.js";
import type { ResolvedHumanizationOptions } from "./human/types.js";

const BROWSER_SESSION_CLOSE_TIMEOUT_MS = 5_000;

export class RoxyBrowser implements Browser {
  constructor(
    private readonly session: ProtocolBrowserSession,
    private readonly adapter: ProtocolBrowserAdapter,
    private readonly humanDefaults: ResolvedHumanizationOptions,
    private readonly browserName: "chromium" | "firefox" = "chromium"
  ) {}

  async newContext(options: BrowserContextOptions = {}): Promise<BrowserContext> {
    const normalizedOptions: BrowserContextOptions = {
      ...options,
      ...(options.extraHTTPHeaders
        ? {
            extraHTTPHeaders: normalizeExtraHTTPHeaders(options.extraHTTPHeaders)
          }
        : {}),
      ...(options.recordVideo
        ? {
            recordVideo: {
              ...options.recordVideo,
              ...(options.recordVideo.dir ? { dir: resolve(options.recordVideo.dir) } : {})
            }
          }
        : {})
    };
    const contextAdapter = await this.session.newContext(normalizedOptions);
    return new RoxyBrowserContext(
      contextAdapter,
      resolveHumanizationOptions(normalizedOptions.human, this.humanDefaults),
      normalizedOptions,
      this.browserName
    );
  }

  async version(): Promise<string> {
    return this.session.version();
  }

  async close(): Promise<void> {
    try {
      await withCloseTimeout(this.session.close(), BROWSER_SESSION_CLOSE_TIMEOUT_MS);
    } finally {
      await this.adapter.close();
    }
  }
}

async function withCloseTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`Timed out closing browser session after ${timeoutMs}ms.`));
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
