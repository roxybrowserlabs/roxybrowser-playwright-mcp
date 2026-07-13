export class NotImplementedInProtocolError extends Error {
  constructor(protocol: string, feature: string) {
    super(`Protocol "${protocol}" has not implemented "${feature}" yet.`);
    this.name = "NotImplementedInProtocolError";
  }
}

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

export class TargetClosedError extends Error {
  constructor(cause?: string) {
    super(cause || "Target page, context or browser has been closed");
    this.name = "TargetClosedError";
  }
}

export class LocatorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocatorError";
  }
}
