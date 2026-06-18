import type { RoxyClockDelegate } from "./clock.js";
import type { Disposable } from "./types/api.js";
import { PLAYWRIGHT_CLOCK_SOURCE } from "./vendor/playwright/generated/clockSource.js";

export interface ClockScriptHost {
  addInitScript(script: string, arg?: unknown): Promise<Disposable>;
  evaluate<TResult>(pageFunction: string, arg?: unknown): Promise<TResult>;
}

type ClockLogType =
  | "fastForward"
  | "install"
  | "pauseAt"
  | "resume"
  | "runFor"
  | "setFixedTime"
  | "setSystemTime";

interface ClockRegistration {
  arg?: unknown;
  evaluateOnAttach: boolean;
  source: string;
}

const CLOCK_BOOTSTRAP_SOURCE = String.raw`(payload) => {
${PLAYWRIGHT_CLOCK_SOURCE}
  if (!globalThis.__pwClock) {
    const bundle = globalThis.__roxyPlaywrightClockBundle;
    if (!bundle?.inject) {
      throw new Error("Playwright clock bundle is not available.");
    }
    globalThis.__pwClock = bundle.inject(globalThis, payload.browserName);
  }
}`;

const CLOCK_LOG_SOURCE = String.raw`(payload) => {
  globalThis.__pwClock?.controller.log(payload.type, payload.recordedAt, payload.param);
}`;

const CLOCK_CALL_SOURCE = String.raw`(payload) => {
  const controller = globalThis.__pwClock?.controller;
  if (!controller) {
    throw new Error("Playwright clock controller is not installed.");
  }
  return payload.param === undefined
    ? controller[payload.method]()
    : controller[payload.method](payload.param);
}`;

const CLOCK_WARMUP_SOURCE = String.raw`() => {
  globalThis.__pwClock?.controller.now();
}`;

export class RoxyBrowserContextClockDelegate implements RoxyClockDelegate {
  private readonly attachedPages = new Set<ClockScriptHost>();
  private readonly registrations: ClockRegistration[] = [];

  async attachPage(page: ClockScriptHost): Promise<void> {
    this.attachedPages.add(page);

    if (!this.registrations.length) {
      return;
    }

    for (const registration of this.registrations) {
      await page.addInitScript(registration.source, registration.arg);
    }

    for (const registration of this.registrations) {
      if (!registration.evaluateOnAttach) {
        continue;
      }
      await page.evaluate(registration.source, registration.arg);
    }

    await page.evaluate(CLOCK_WARMUP_SOURCE);
  }

  detachPage(page: ClockScriptHost): void {
    this.attachedPages.delete(page);
  }

  async fastForward(ticks: { ticksNumber?: number; ticksString?: string }): Promise<void> {
    const value = parseClockTicks(ticks);
    await this.recordAndInvoke("fastForward", value);
  }

  async install(options: { timeNumber?: number; timeString?: string } | {}): Promise<void> {
    const value = parseClockTime(options) ?? Date.now();
    await this.recordAndInvoke("install", value);
  }

  async pauseAt(time: { timeNumber?: number; timeString?: string }): Promise<void> {
    await this.recordAndInvoke("pauseAt", parseClockTime(time) ?? 0);
  }

  async resume(): Promise<void> {
    await this.recordAndInvoke("resume");
  }

  async runFor(ticks: { ticksNumber?: number; ticksString?: string }): Promise<void> {
    const value = parseClockTicks(ticks);
    await this.recordAndInvoke("runFor", value);
  }

  async setFixedTime(time: { timeNumber?: number; timeString?: string }): Promise<void> {
    await this.recordAndInvoke("setFixedTime", parseClockTime(time) ?? 0);
  }

  async setSystemTime(time: { timeNumber?: number; timeString?: string }): Promise<void> {
    await this.recordAndInvoke("setSystemTime", parseClockTime(time) ?? 0);
  }

  private async ensureBootstrapRegistered(): Promise<void> {
    if (this.registrations.length) {
      return;
    }

    const registration: ClockRegistration = {
      arg: {},
      evaluateOnAttach: true,
      source: CLOCK_BOOTSTRAP_SOURCE
    };
    this.registrations.push(registration);

    await Promise.all(
      Array.from(this.attachedPages).map(async (page) => {
        await page.addInitScript(registration.source, registration.arg);
        await page.evaluate(registration.source, registration.arg);
      })
    );
  }

  private async recordAndInvoke(type: ClockLogType, param?: number): Promise<void> {
    await this.ensureBootstrapRegistered();

    const logRegistration: ClockRegistration = {
      arg: {
        type,
        recordedAt: Date.now(),
        ...(param !== undefined ? { param } : {})
      },
      evaluateOnAttach: true,
      source: CLOCK_LOG_SOURCE
    };
    this.registrations.push(logRegistration);

    await Promise.all(
      Array.from(this.attachedPages).map(async (page) => {
        await page.addInitScript(logRegistration.source, logRegistration.arg);
      })
    );

    await Promise.all(
      Array.from(this.attachedPages).map((page) =>
        page.evaluate(CLOCK_CALL_SOURCE, {
          method: type,
          ...(param !== undefined ? { param } : {})
        })
      )
    );
  }
}

function parseClockTicks(value: { ticksNumber?: number; ticksString?: string }): number {
  if (value.ticksNumber !== undefined) {
    return value.ticksNumber;
  }
  return parseTicksString(value.ticksString);
}

function parseClockTime(value: { timeNumber?: number; timeString?: string } | {}): number | undefined {
  if ("timeNumber" in value && value.timeNumber !== undefined) {
    return value.timeNumber;
  }
  if ("timeString" in value && value.timeString !== undefined) {
    const parsed = new Date(value.timeString);
    if (!Number.isFinite(parsed.getTime())) {
      throw new Error(`Invalid date: ${value.timeString}`);
    }
    return parsed.getTime();
  }
  return undefined;
}

function parseTicksString(value: string | undefined): number {
  if (!value) {
    return 0;
  }

  const parts = value.split(":");
  if (parts.length > 3 || !/^(\d\d:){0,2}\d\d?$/.test(value)) {
    throw new Error("Clock only understands numbers, 'mm:ss' and 'hh:mm:ss'");
  }

  let seconds = 0;
  for (let index = 0; index < parts.length; index += 1) {
    const part = Number.parseInt(parts[parts.length - 1 - index] ?? "0", 10);
    if (part >= 60) {
      throw new Error(`Invalid time ${value}`);
    }
    seconds += part * 60 ** index;
  }

  return seconds * 1000;
}
