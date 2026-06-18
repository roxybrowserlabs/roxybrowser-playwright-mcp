import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DefaultHumanController } from "../../../src/human/controller.js";
import type { HumanActionTarget } from "../../../src/human/types.js";

function createTarget(): HumanActionTarget {
  return {
    click: vi.fn(async () => {}),
    hover: vi.fn(async () => {}),
    fill: vi.fn(async () => {}),
    type: vi.fn(async () => {}),
    press: vi.fn(async () => {})
  };
}

describe("DefaultHumanController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("hovers before click and applies default click delay", async () => {
    const controller = new DefaultHumanController({
      enabled: true,
      profile: "balanced",
      moveJitterMs: 1,
      clickHoldMs: 88,
      scrollStepPx: 2,
      typingDelayMs: 33,
      typingVarianceMs: 4,
      hoverBeforeClickMs: 25
    });
    const target = createTarget();

    const pending = controller.click(target, { button: "right" });
    await vi.advanceTimersByTimeAsync(25);
    await pending;

    expect(target.hover).toHaveBeenCalledWith({ button: "right" });
    expect(target.click).toHaveBeenCalledWith({
      button: "right",
      delay: 88
    });
  });

  it("skips wait when hoverBeforeClickMs is zero and preserves explicit delay", async () => {
    const controller = new DefaultHumanController({
      enabled: true,
      profile: "fast",
      moveJitterMs: 1,
      clickHoldMs: 60,
      scrollStepPx: 2,
      typingDelayMs: 33,
      typingVarianceMs: 4,
      hoverBeforeClickMs: 0
    });
    const target = createTarget();

    await controller.click(target, { delay: 9 });

    expect(target.hover).toHaveBeenCalledTimes(1);
    expect(target.click).toHaveBeenCalledWith({ delay: 9 });
  });

  it("forwards fill, type and press with default typing delay", async () => {
    const controller = new DefaultHumanController({
      enabled: true,
      profile: "balanced",
      moveJitterMs: 1,
      clickHoldMs: 50,
      scrollStepPx: 2,
      typingDelayMs: 77,
      typingVarianceMs: 4,
      hoverBeforeClickMs: 0
    });
    const target = createTarget();

    await controller.fill(target, "hello", { force: true });
    await controller.type(target, "hello");
    await controller.press(target, "Enter");

    expect(target.fill).toHaveBeenCalledWith("hello", { force: true });
    expect(target.type).toHaveBeenCalledWith("hello", { delay: 77 });
    expect(target.press).toHaveBeenCalledWith("Enter", { delay: 77 });
  });

  it("treats human disabled as pure pass-through behavior", async () => {
    const controller = new DefaultHumanController({
      enabled: true,
      profile: "balanced",
      moveJitterMs: 1,
      clickHoldMs: 50,
      scrollStepPx: 2,
      typingDelayMs: 77,
      typingVarianceMs: 4,
      hoverBeforeClickMs: 25
    });
    const target = createTarget();

    await controller.click(target, { human: { enabled: false }, delay: 9 });
    await controller.type(target, "hello", { human: { enabled: false } });
    await controller.press(target, "Enter", { human: { enabled: false } });

    expect(target.hover).not.toHaveBeenCalled();
    expect(target.click).toHaveBeenCalledWith({ human: { enabled: false }, delay: 9 });
    expect(target.type).toHaveBeenCalledWith("hello", { human: { enabled: false } });
    expect(target.press).toHaveBeenCalledWith("Enter", { human: { enabled: false } });
  });

  it("serializes concurrent clicks within the same controller", async () => {
    const controller = new DefaultHumanController({
      enabled: true,
      profile: "fast",
      moveJitterMs: 1,
      clickHoldMs: 60,
      scrollStepPx: 2,
      typingDelayMs: 33,
      typingVarianceMs: 4,
      hoverBeforeClickMs: 0
    });
    let markFirstClickStarted!: () => void;
    const firstClickStarted = new Promise<void>((resolve) => {
      markFirstClickStarted = resolve;
    });
    let resolveFirstClick!: () => void;
    const target: HumanActionTarget = {
      click: vi
        .fn<HumanActionTarget["click"]>()
        .mockImplementationOnce(
          async () => {
            markFirstClickStarted();
            return new Promise<void>((resolve) => {
              resolveFirstClick = resolve;
            });
          }
        )
        .mockResolvedValue(undefined),
      hover: vi.fn(async () => {}),
      fill: vi.fn(async () => {}),
      type: vi.fn(async () => {}),
      press: vi.fn(async () => {})
    };

    const firstClick = controller.click(target);
    const secondClick = controller.click(target);

    await firstClickStarted;
    expect(target.hover).toHaveBeenCalledTimes(1);
    expect(target.click).toHaveBeenCalledTimes(1);

    resolveFirstClick();
    await firstClick;
    await secondClick;

    expect(target.hover).toHaveBeenCalledTimes(2);
    expect(target.click).toHaveBeenCalledTimes(2);
  });
});
