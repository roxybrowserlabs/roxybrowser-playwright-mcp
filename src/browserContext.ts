import { RoxyPage } from "./page.js";
import type { ResolvedHumanizationOptions } from "./human/types.js";
import type { ProtocolBrowserContextAdapter } from "./protocol/adapter.js";
import type { BrowserContext, Page } from "./types/api.js";

export class RoxyBrowserContext implements BrowserContext {
  constructor(
    private readonly adapter: ProtocolBrowserContextAdapter,
    private readonly humanDefaults: ResolvedHumanizationOptions
  ) {}

  async newPage(): Promise<Page> {
    const pageAdapter = await this.adapter.newPage();
    return new RoxyPage(pageAdapter, this.humanDefaults);
  }

  async close(): Promise<void> {
    await this.adapter.close();
  }
}

