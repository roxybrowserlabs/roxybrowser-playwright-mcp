import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DefaultHumanController } from "../../../src/human/controller.js";
import type { HumanActionTarget } from "../../../src/human/types.js";

function createTarget(): HumanActionTarget {
  return {
    click: vi.fn(async () => {}),
    evaluate: vi.fn(async () => true),
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

    expect(target.evaluate).toHaveBeenCalledTimes(1);
    expect(target.evaluate).toHaveBeenCalledWith(expect.any(String), undefined, false);
    expect(target.hover).not.toHaveBeenCalled();
    expect(target.click).toHaveBeenCalledWith({
      button: "right",
      __roxyHumanMove: {
        durationMs: 1,
        stepPx: 24
      },
      delay: 88
    });
  });

  it("skips wait when hoverBeforeClickMs is zero and preserves explicit delay", async () => {
    const controller = new DefaultHumanController({
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

    expect(target.evaluate).toHaveBeenCalledTimes(1);
    expect(target.hover).not.toHaveBeenCalled();
    expect(target.click).toHaveBeenCalledWith({
      delay: 9,
      __roxyHumanMove: {
        durationMs: 1,
        stepPx: 24
      }
    });
  });

  it("forwards fill, type and press with default typing delay", async () => {
    const controller = new DefaultHumanController({
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

    expect(target.evaluate).not.toHaveBeenCalled();
    expect(target.hover).not.toHaveBeenCalled();
    expect(target.click).not.toHaveBeenCalled();
    expect(target.fill).toHaveBeenCalledWith("hello", { force: true });
    expect(target.type).toHaveBeenCalledWith("hello", { delay: 77 });
    expect(target.press).toHaveBeenCalledWith("Enter", { delay: 77 });
  });

  it("still humanizes when a profile override is passed", async () => {
    const controller = new DefaultHumanController({
      profile: "balanced",
      moveJitterMs: 1,
      clickHoldMs: 50,
      scrollStepPx: 2,
      typingDelayMs: 77,
      typingVarianceMs: 4,
      hoverBeforeClickMs: 25
    });
    const target = createTarget();

    const clickPromise = controller.click(target, { human: { profile: "fast" }, delay: 9 });
    const typePromise = controller.type(target, "hello", { human: { profile: "fast" } });
    const pressPromise = controller.press(target, "Enter", { human: { profile: "fast" } });
    await vi.advanceTimersByTimeAsync(100);
    await clickPromise;
    await typePromise;
    await pressPromise;

    expect(target.evaluate).toHaveBeenCalledTimes(1);
    expect(target.hover).not.toHaveBeenCalled();
    expect(target.click).toHaveBeenCalledWith({
      human: { profile: "fast" },
      delay: 9,
      __roxyHumanMove: {
        durationMs: 1,
        stepPx: 24
      }
    });
    expect(target.type).toHaveBeenCalledWith("hello", { human: { profile: "fast" }, delay: 77 });
    expect(target.press).toHaveBeenCalledWith("Enter", { human: { profile: "fast" }, delay: 77 });
  });

  it("serializes concurrent clicks within the same controller", async () => {
    const controller = new DefaultHumanController({
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
      evaluate: vi.fn(async () => true),
      hover: vi.fn(async () => {}),
      fill: vi.fn(async () => {}),
      type: vi.fn(async () => {}),
      press: vi.fn(async () => {})
    };

    const firstClick = controller.click(target);
    const secondClick = controller.click(target);

    await firstClickStarted;
    expect(target.evaluate).toHaveBeenCalledTimes(2);
    expect(target.hover).not.toHaveBeenCalled();
    expect(target.click).toHaveBeenCalledTimes(1);

    resolveFirstClick();
    await firstClick;
    await secondClick;

    expect(target.evaluate).toHaveBeenCalledTimes(2);
    expect(target.hover).not.toHaveBeenCalled();
    expect(target.click).toHaveBeenCalledTimes(2);
  });
});
