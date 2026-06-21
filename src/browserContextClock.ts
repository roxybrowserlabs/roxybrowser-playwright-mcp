import type { RoxyClockDelegate } from "./clock.js";
import type { Disposable } from "./types/api.js";
import { PLAYWRIGHT_CLOCK_SOURCE } from "./vendor/playwright/generated/clockSource.js";

export interface ClockScriptHost {
  addInitScript<Arg>(script: string | ((arg: Arg) => unknown), arg?: Arg): Promise<Disposable>;
  evaluate<TResult, Arg>(pageFunction: string | ((arg: Arg) => TResult), arg?: Arg): Promise<TResult>;
  flushExposedBindingCallsForInternalUse?(): Promise<void>;
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
  script: string | ((arg?: unknown) => unknown);
}

const CLOCK_BOOTSTRAP_SOURCE = new Function("payload", `
${PLAYWRIGHT_CLOCK_SOURCE}
  if (!globalThis.__pwClock) {
    const bundle = globalThis.__roxyPlaywrightClockBundle;
    if (!bundle?.inject) {
      throw new Error("Playwright clock bundle is not available.");
    }
    globalThis.__pwClock = bundle.inject(globalThis, payload.browserName);
  }
`) as (payload: { browserName?: string }) => void;

const CLOCK_LOG_SOURCE = ((payload: {
  type: ClockLogType;
  recordedAt: number;
  param?: number;
}) => {
  globalThis.__pwClock?.controller.log(payload.type, payload.recordedAt, payload.param);
}) as (payload: {
  type: ClockLogType;
  recordedAt: number;
  param?: number;
}) => void;

const CLOCK_CALL_SOURCE = ((payload: {
  method: ClockLogType;
  param?: number;
}) => {
  const controller = globalThis.__pwClock?.controller;
  if (!controller) {
    throw new Error("Playwright clock controller is not installed.");
  }
  return payload.param === undefined
    ? controller[payload.method]()
    : controller[payload.method](payload.param);
}) as (payload: {
  method: ClockLogType;
  param?: number;
}) => unknown;

const CLOCK_WARMUP_SOURCE = (() => {
  globalThis.__pwClock?.controller.now();
}) as () => void;

export class RoxyBrowserContextClockDelegate implements RoxyClockDelegate {
  private readonly attachedPages = new Set<ClockScriptHost>();
  private readonly registrations: ClockRegistration[] = [];

  async attachPage(page: ClockScriptHost): Promise<void> {
    this.attachedPages.add(page);

    if (!this.registrations.length) {
      return;
    }

    for (const registration of this.registrations) {
      await page.addInitScript(registration.script, registration.arg);
    }

    for (const registration of this.registrations) {
      if (!registration.evaluateOnAttach) {
        continue;
      }
      await page.evaluate(registration.script, registration.arg);
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
      script: CLOCK_BOOTSTRAP_SOURCE
    };
    this.registrations.push(registration);

    await Promise.all(
      Array.from(this.attachedPages).map(async (page) => {
        await page.addInitScript(registration.script, registration.arg);
        await page.evaluate(registration.script, registration.arg);
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
      script: CLOCK_LOG_SOURCE
    };
    this.registrations.push(logRegistration);

    await Promise.all(
      Array.from(this.attachedPages).map(async (page) => {
        await page.addInitScript(logRegistration.script, logRegistration.arg);
      })
    );

    await Promise.all(
      Array.from(this.attachedPages).map(async (page) => {
        await page.evaluate(CLOCK_CALL_SOURCE, {
          method: type,
          ...(param !== undefined ? { param } : {})
        });
        await page.flushExposedBindingCallsForInternalUse?.();
      })
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
