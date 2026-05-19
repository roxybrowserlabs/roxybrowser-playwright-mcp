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

export class LocatorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocatorError";
  }
}
