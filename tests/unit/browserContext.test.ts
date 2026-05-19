import { describe, expect, it } from "vitest";
import { RoxyBrowserContext } from "../../src/browserContext.js";
import { RoxyPage } from "../../src/page.js";
import {
  createBrowserContextAdapterStub,
  createPageAdapterStub
} from "../helpers/fakes.js";

describe("RoxyBrowserContext", () => {
  it("creates roxy pages from the underlying adapter", async () => {
    const adapter = createBrowserContextAdapterStub();
    adapter.newPage = async () => createPageAdapterStub();
    const context = new RoxyBrowserContext(adapter, {
      enabled: true,
      profile: "balanced",
      moveJitterMs: 16,
      clickHoldMs: 60,
      scrollStepPx: 280,
      typingDelayMs: 95,
      typingVarianceMs: 35,
      hoverBeforeClickMs: 110
    });

    const page = await context.newPage();

    expect(page).toBeInstanceOf(RoxyPage);
  });

  it("closes via the context adapter", async () => {
    const adapter = createBrowserContextAdapterStub();
    const context = new RoxyBrowserContext(adapter, {
      enabled: true,
      profile: "balanced",
      moveJitterMs: 16,
      clickHoldMs: 60,
      scrollStepPx: 280,
      typingDelayMs: 95,
      typingVarianceMs: 35,
      hoverBeforeClickMs: 110
    });

    await context.close();

    expect(adapter.close).toHaveBeenCalledTimes(1);
  });
});

