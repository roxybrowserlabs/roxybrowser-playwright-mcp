import { describe, expect, it, vi } from "vitest";
import { RoxyClock } from "../../src/clock.js";

describe("RoxyClock", () => {
  it("parses and forwards install/time methods like Playwright client clock", async () => {
    const delegate = {
      fastForward: vi.fn(async () => {}),
      install: vi.fn(async () => {}),
      pauseAt: vi.fn(async () => {}),
      resume: vi.fn(async () => {}),
      runFor: vi.fn(async () => {}),
      setFixedTime: vi.fn(async () => {}),
      setSystemTime: vi.fn(async () => {})
    };
    const clock = new RoxyClock(delegate);
    const date = new Date("2020-02-02T00:00:00.000Z");

    await clock.install({ time: date });
    await clock.pauseAt("2020-02-03");
    await clock.fastForward(1000);
    await clock.runFor("01:00");
    await clock.setFixedTime(2500);
    await clock.setSystemTime(date);
    await clock.resume();

    expect(delegate.install).toHaveBeenCalledWith({ timeNumber: date.getTime() });
    expect(delegate.pauseAt).toHaveBeenCalledWith({ timeString: "2020-02-03" });
    expect(delegate.fastForward).toHaveBeenCalledWith({ ticksNumber: 1000, ticksString: undefined });
    expect(delegate.runFor).toHaveBeenCalledWith({ ticksNumber: undefined, ticksString: "01:00" });
    expect(delegate.setFixedTime).toHaveBeenCalledWith({ timeNumber: 2500 });
    expect(delegate.setSystemTime).toHaveBeenCalledWith({ timeNumber: date.getTime() });
    expect(delegate.resume).toHaveBeenCalledWith();
  });

  it("throws on invalid Date objects before delegating", async () => {
    const delegate = {
      fastForward: vi.fn(async () => {}),
      install: vi.fn(async () => {}),
      pauseAt: vi.fn(async () => {}),
      resume: vi.fn(async () => {}),
      runFor: vi.fn(async () => {}),
      setFixedTime: vi.fn(async () => {}),
      setSystemTime: vi.fn(async () => {})
    };
    const clock = new RoxyClock(delegate);
    const invalidDate = new Date("invalid");

    await expect(clock.install({ time: invalidDate })).rejects.toThrow("Invalid date: Invalid Date");
    await expect(clock.pauseAt(invalidDate)).rejects.toThrow("Invalid date: Invalid Date");
    await expect(clock.setFixedTime(invalidDate)).rejects.toThrow("Invalid date: Invalid Date");
    await expect(clock.setSystemTime(invalidDate)).rejects.toThrow("Invalid date: Invalid Date");

    expect(delegate.install).not.toHaveBeenCalled();
    expect(delegate.pauseAt).not.toHaveBeenCalled();
    expect(delegate.setFixedTime).not.toHaveBeenCalled();
    expect(delegate.setSystemTime).not.toHaveBeenCalled();
  });
});
