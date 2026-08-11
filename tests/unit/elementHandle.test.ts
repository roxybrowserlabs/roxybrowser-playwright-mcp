import { describe, expect, it, vi } from "vitest";
import { RoxyElementHandle } from "../../src/elementHandle.js";
import type { ProtocolElementHandleAdapter } from "../../src/protocol/adapter.js";
import type { ClickOptions } from "../../src/types/options.js";

describe("RoxyElementHandle", () => {
  const actions = [
    {
      name: "tap",
      invoke: (handle: RoxyElementHandle, signal: AbortSignal) => handle.tap({ signal }),
      adapterMethod: "tap"
    },
    {
      name: "click",
      invoke: (handle: RoxyElementHandle, signal: AbortSignal) => handle.click({ signal }),
      adapterMethod: "click"
    },
    {
      name: "dblclick",
      invoke: (handle: RoxyElementHandle, signal: AbortSignal) => handle.dblclick({ signal }),
      adapterMethod: "dblclick"
    },
    {
      name: "check",
      invoke: (handle: RoxyElementHandle, signal: AbortSignal) => handle.check({ signal }),
      adapterMethod: "check"
    },
    {
      name: "hover",
      invoke: (handle: RoxyElementHandle, signal: AbortSignal) => handle.hover({ signal }),
      adapterMethod: "hover"
    },
    {
      name: "fill",
      invoke: (handle: RoxyElementHandle, signal: AbortSignal) => handle.fill("value", { signal }),
      adapterMethod: "fill"
    },
    {
      name: "type",
      invoke: (handle: RoxyElementHandle, signal: AbortSignal) => handle.type("value", { signal }),
      adapterMethod: "type"
    },
    {
      name: "press",
      invoke: (handle: RoxyElementHandle, signal: AbortSignal) => handle.press("Enter", { signal }),
      adapterMethod: "press"
    },
    {
      name: "uncheck",
      invoke: (handle: RoxyElementHandle, signal: AbortSignal) => handle.uncheck({ signal }),
      adapterMethod: "uncheck"
    }
  ] as const;

  it.each(actions)("aborts $name before dispatching to the adapter like Playwright", async ({ invoke, adapterMethod }) => {
    const adapter = createElementAdapter();
    const handle = new RoxyElementHandle(adapter);
    const controller = new AbortController();
    const reason = new Error("Already aborted");
    controller.abort(reason);

    const error = await invoke(handle, controller.signal).catch((caught: Error) => caught);

    expect(error.name).toBe("AbortError");
    expect(error.cause).toBe(reason);
    expect(error.message).toContain("The operation was aborted");
    expect(adapter[adapterMethod]).not.toHaveBeenCalled();
  });

  it("aborts click while waiting for the adapter like Playwright", async () => {
    const adapter = createElementAdapter();
    adapter.click = vi.fn(() => new Promise(() => {}));
    const handle = new RoxyElementHandle(adapter);
    const controller = new AbortController();

    const promise = handle.click({ signal: controller.signal, timeout: 0 }).catch((caught: Error) => caught);
    const reason = new Error("foo bar");
    controller.abort(reason);
    const error = await Promise.race([
      promise,
      new Promise<Error>((resolve) => setTimeout(() => resolve(new Error("click did not abort")), 25))
    ]);

    expect(error.name).toBe("AbortError");
    expect(error.cause).toBe(reason);
    expect(error.message).toContain("The operation was aborted");
    expect(adapter.click).toHaveBeenCalledWith({ signal: controller.signal, timeout: 0 });
  });

  it("aborts selectOption while normalizing option handles like Playwright", async () => {
    const adapter = createElementAdapter();
    adapter.evaluate = vi.fn(async () => {
      await new Promise(() => {});
      return -1;
    });
    const handle = new RoxyElementHandle(adapter);
    const option = new RoxyElementHandle(createElementAdapter());
    const controller = new AbortController();

    const promise = handle.selectOption(option, { signal: controller.signal, timeout: 0 }).catch((caught: Error) => caught);
    controller.abort("cancelled");
    const error = await Promise.race([
      promise,
      new Promise<Error>((resolve) => setTimeout(() => resolve(new Error("selectOption did not abort")), 25))
    ]);

    expect(error.name).toBe("AbortError");
    expect(adapter.evaluate).toHaveBeenCalledTimes(1);
    expect(adapter.selectOption).not.toHaveBeenCalled();
  });

  it("aborts waitForSelector while polling like Playwright", async () => {
    const adapter = createElementAdapter();
    adapter.query = vi.fn(async () => null);
    const handle = new RoxyElementHandle(adapter);
    const controller = new AbortController();

    const promise = handle.waitForSelector("span", { signal: controller.signal, timeout: 1000 }).catch((caught: Error) => caught);

    await Promise.resolve();
    const reason = new Error("cancelled");
    controller.abort(reason);
    const error = await Promise.race([
      promise,
      new Promise<Error>((resolve) => setTimeout(() => resolve(new Error("waitForSelector did not abort")), 25))
    ]);

    expect(error.name).toBe("AbortError");
    expect(error.cause).toBe(reason);
    expect(error.message).toContain("The operation was aborted");
    expect(adapter.query).toHaveBeenCalledWith([{ strategy: "css", value: "span" }]);
  });

  const signalOnlyMethods = [
    {
      name: "textContent",
      invoke: (handle: RoxyElementHandle, signal: AbortSignal) => handle.textContent({ signal }),
      adapterMethod: "textContent"
    },
    {
      name: "innerText",
      invoke: (handle: RoxyElementHandle, signal: AbortSignal) => handle.innerText({ signal }),
      adapterMethod: "innerText"
    },
    {
      name: "innerHTML",
      invoke: (handle: RoxyElementHandle, signal: AbortSignal) => handle.innerHTML({ signal }),
      adapterMethod: "innerHTML"
    },
    {
      name: "getAttribute",
      invoke: (handle: RoxyElementHandle, signal: AbortSignal) => handle.getAttribute("data-id", { signal }),
      adapterMethod: "getAttribute"
    },
    {
      name: "inputValue",
      invoke: (handle: RoxyElementHandle, signal: AbortSignal) => handle.inputValue({ signal }),
      adapterMethod: "inputValue"
    },
    {
      name: "isChecked",
      invoke: (handle: RoxyElementHandle, signal: AbortSignal) => handle.isChecked({ signal }),
      adapterMethod: "isChecked"
    },
    {
      name: "isDisabled",
      invoke: (handle: RoxyElementHandle, signal: AbortSignal) => handle.isDisabled({ signal }),
      adapterMethod: "isDisabled"
    },
    {
      name: "isEditable",
      invoke: (handle: RoxyElementHandle, signal: AbortSignal) => handle.isEditable({ signal }),
      adapterMethod: "isEditable"
    },
    {
      name: "isEnabled",
      invoke: (handle: RoxyElementHandle, signal: AbortSignal) => handle.isEnabled({ signal }),
      adapterMethod: "isEnabled"
    },
    {
      name: "focus",
      invoke: (handle: RoxyElementHandle, signal: AbortSignal) => handle.focus({ signal }),
      adapterMethod: "focus"
    }
  ] as const;

  it.each(signalOnlyMethods)("aborts $name before dispatching to the adapter like Playwright", async ({ invoke, adapterMethod }) => {
    const adapter = createElementAdapter();
    const handle = new RoxyElementHandle(adapter);
    const controller = new AbortController();
    const reason = new Error("Already aborted");
    controller.abort(reason);

    const error = await invoke(handle, controller.signal).catch((caught: Error) => caught);

    expect(error.name).toBe("AbortError");
    expect(error.cause).toBe(reason);
    expect(error.message).toContain("The operation was aborted");
    expect(adapter[adapterMethod]).not.toHaveBeenCalled();
  });
});

function createElementAdapter(): ProtocolElementHandleAdapter {
  return {
    reference: () => ({ objectId: "element-1" }),
    query: vi.fn(),
    queryAll: vi.fn(),
    evalOnSelector: vi.fn(),
    evalOnSelectorAll: vi.fn(),
    evaluate: vi.fn(),
    boundingBox: vi.fn(),
    dispatchEvent: vi.fn(),
    screenshot: vi.fn(),
    scrollIntoViewIfNeeded: vi.fn(),
    selectText: vi.fn(),
    tap: vi.fn(),
    click: vi.fn(async (_options?: ClickOptions) => {}),
    dblclick: vi.fn(),
    check: vi.fn(),
    hover: vi.fn(),
    fill: vi.fn(),
    type: vi.fn(),
    press: vi.fn(),
    textContent: vi.fn(),
    innerText: vi.fn(),
    innerHTML: vi.fn(),
    getAttribute: vi.fn(),
    inputValue: vi.fn(),
    isChecked: vi.fn(),
    isDisabled: vi.fn(),
    isEditable: vi.fn(),
    isEnabled: vi.fn(),
    isHidden: vi.fn(),
    isVisible: vi.fn(),
    focus: vi.fn(),
    uncheck: vi.fn(),
    selectOption: vi.fn()
  } as ProtocolElementHandleAdapter;
}
