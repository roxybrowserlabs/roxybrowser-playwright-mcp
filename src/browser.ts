import { RoxyBrowserContext } from "./browserContext.js";
import { resolveHumanizationOptions } from "./human/profile.js";
import type {
  ProtocolBrowserAdapter,
  ProtocolBrowserSession
} from "./protocol/adapter.js";
import type { Browser, BrowserContext } from "./types/api.js";
import type { BrowserContextOptions } from "./types/options.js";
import type { ResolvedHumanizationOptions } from "./human/types.js";

export class RoxyBrowser implements Browser {
  constructor(
    private readonly session: ProtocolBrowserSession,
    private readonly adapter: ProtocolBrowserAdapter,
    private readonly humanDefaults: ResolvedHumanizationOptions
  ) {}

  async newContext(options: BrowserContextOptions = {}): Promise<BrowserContext> {
    const contextAdapter = await this.session.newContext(options);
    return new RoxyBrowserContext(
      contextAdapter,
      resolveHumanizationOptions(options.human, this.humanDefaults)
    );
  }

  async version(): Promise<string> {
    return this.session.version();
  }

  async close(): Promise<void> {
    try {
      await this.session.close();
    } finally {
      await this.adapter.close();
    }
  }
}
