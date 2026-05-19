import { describe, expect, it } from "vitest";
import {
  LocatorError,
  NotImplementedInProtocolError,
  TimeoutError
} from "../../src/errors.js";

describe("errors", () => {
  it("creates named protocol errors", () => {
    const error = new NotImplementedInProtocolError("cdp", "page.goto");

    expect(error.name).toBe("NotImplementedInProtocolError");
    expect(error.message).toContain('Protocol "cdp"');
    expect(error.message).toContain('"page.goto"');
  });

  it("creates timeout and locator errors", () => {
    const timeout = new TimeoutError("took too long");
    const locator = new LocatorError("missing selector");

    expect(timeout.name).toBe("TimeoutError");
    expect(locator.name).toBe("LocatorError");
    expect(timeout.message).toBe("took too long");
    expect(locator.message).toBe("missing selector");
  });
});

