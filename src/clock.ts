import type { Clock as ClockApi } from "./types/api.js";

export interface RoxyClockDelegate {
  fastForward(ticks: { ticksNumber?: number; ticksString?: string }): Promise<void>;
  install(options: { timeNumber?: number; timeString?: string } | {}): Promise<void>;
  pauseAt(time: { timeNumber?: number; timeString?: string }): Promise<void>;
  resume(): Promise<void>;
  runFor(ticks: { ticksNumber?: number; ticksString?: string }): Promise<void>;
  setFixedTime(time: { timeNumber?: number; timeString?: string }): Promise<void>;
  setSystemTime(time: { timeNumber?: number; timeString?: string }): Promise<void>;
}

export class RoxyClock implements ClockApi {
  constructor(private readonly delegate: RoxyClockDelegate) {}

  async install(options: { time?: number | string | Date } = {}): Promise<void> {
    await this.delegate.install(
      options.time !== undefined ? parseTime(options.time) : {}
    );
  }

  async fastForward(ticks: number | string): Promise<void> {
    await this.delegate.fastForward(parseTicks(ticks));
  }

  async pauseAt(time: number | string | Date): Promise<void> {
    await this.delegate.pauseAt(parseTime(time));
  }

  async resume(): Promise<void> {
    await this.delegate.resume();
  }

  async runFor(ticks: number | string): Promise<void> {
    await this.delegate.runFor(parseTicks(ticks));
  }

  async setFixedTime(time: number | string | Date): Promise<void> {
    await this.delegate.setFixedTime(parseTime(time));
  }

  async setSystemTime(time: number | string | Date): Promise<void> {
    await this.delegate.setSystemTime(parseTime(time));
  }
}

export function createUnsupportedClockDelegate(prefix = "clock"): RoxyClockDelegate {
  return {
    fastForward: async () => {
      throw new Error(`${prefix}.fastForward is not implemented yet.`);
    },
    install: async () => {
      throw new Error(`${prefix}.install is not implemented yet.`);
    },
    pauseAt: async () => {
      throw new Error(`${prefix}.pauseAt is not implemented yet.`);
    },
    resume: async () => {
      throw new Error(`${prefix}.resume is not implemented yet.`);
    },
    runFor: async () => {
      throw new Error(`${prefix}.runFor is not implemented yet.`);
    },
    setFixedTime: async () => {
      throw new Error(`${prefix}.setFixedTime is not implemented yet.`);
    },
    setSystemTime: async () => {
      throw new Error(`${prefix}.setSystemTime is not implemented yet.`);
    }
  };
}

function parseTime(time: number | string | Date): {
  timeNumber?: number;
  timeString?: string;
} {
  if (typeof time === "number") {
    return { timeNumber: time };
  }
  if (typeof time === "string") {
    return { timeString: time };
  }
  if (!Number.isFinite(time.getTime())) {
    throw new Error(`Invalid date: ${time}`);
  }
  return { timeNumber: time.getTime() };
}

function parseTicks(ticks: number | string): {
  ticksNumber?: number;
  ticksString?: string;
} {
  return typeof ticks === "number"
    ? { ticksNumber: ticks }
    : { ticksString: ticks };
}
