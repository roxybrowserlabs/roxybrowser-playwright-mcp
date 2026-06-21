import { expect } from "vitest";

type LocatorLike = {
  page?: () => {
    waitForEvent?: (
      event: "close",
      options?: { timeout?: number }
    ) => Promise<unknown>;
  } | null;
  allTextContents?: () => Promise<Array<string>>;
  textContent?: () => Promise<string | null>;
};

type TextExpectation = string | RegExp | ReadonlyArray<string | RegExp>;

const DEFAULT_EXPECT_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 50;

function isLocatorLike(value: unknown): value is LocatorLike {
  return typeof value === "object"
    && value !== null
    && (
      typeof (value as LocatorLike).textContent === "function"
      || typeof (value as LocatorLike).allTextContents === "function"
    );
}

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function matchesText(actual: string, expected: string | RegExp): boolean {
  return expected instanceof RegExp ? expected.test(actual) : actual === expected;
}

function formatExpected(expected: TextExpectation): string {
  if (Array.isArray(expected)) {
    return `[${expected.map((item) => formatExpected(item)).join(", ")}]`;
  }
  return expected instanceof RegExp ? String(expected) : JSON.stringify(expected);
}

function formatActual(actual: string | Array<string>): string {
  return Array.isArray(actual)
    ? `[${actual.map((item) => JSON.stringify(item)).join(", ")}]`
    : JSON.stringify(actual);
}

function isCloseInterruption(error: unknown): boolean {
  const message = String(error instanceof Error ? error.message : error);
  return (
    message.includes("Target page, context or browser has been closed")
    || message.includes("Frame execution context is not available")
  );
}

async function readLocatorText(locator: LocatorLike, expected: TextExpectation): Promise<string | Array<string>> {
  try {
    if (Array.isArray(expected)) {
      if (typeof locator.allTextContents === "function") {
        return (await locator.allTextContents()).map((value) => normalizeText(value));
      }
      const single = typeof locator.textContent === "function" ? await locator.textContent() : "";
      return [normalizeText(single)];
    }
    if (typeof locator.textContent === "function") {
      return normalizeText(await locator.textContent());
    }
    if (typeof locator.allTextContents === "function") {
      return normalizeText((await locator.allTextContents())[0] ?? "");
    }
    return "";
  } catch (error) {
    if (isCloseInterruption(error)) {
      throw new Error("Target page, context or browser has been closed");
    }
    throw error;
  }
}

function passTextExpectation(actual: string | Array<string>, expected: TextExpectation): boolean {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) {
      return false;
    }
    return expected.every((item, index) => matchesText(actual[index] ?? "", item));
  }
  if (Array.isArray(actual)) {
    return actual.length === 1 && matchesText(actual[0] ?? "", expected);
  }
  return matchesText(actual, expected);
}

async function pollLocatorText(locator: LocatorLike, expected: TextExpectation): Promise<{
  actual: string | Array<string>;
  pass: boolean;
  interruptedByClose?: boolean;
}> {
  const deadline = Date.now() + DEFAULT_EXPECT_TIMEOUT_MS;
  let actual = await readLocatorText(locator, expected);
  const page = typeof locator.page === "function" ? locator.page() : null;
  const closePromise =
    typeof page?.waitForEvent === "function"
      ? page.waitForEvent("close", { timeout: 0 }).then(() => {
          throw new Error("Target page, context or browser has been closed");
        })
      : null;

  while (!passTextExpectation(actual, expected) && Date.now() < deadline) {
    try {
      await (closePromise
        ? Promise.race([
            new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS)),
            closePromise
          ])
        : new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS)));
      actual = await readLocatorText(locator, expected);
    } catch (error) {
      const message = String(error instanceof Error ? error.message : error);
      if (isCloseInterruption(error)) {
        return {
          actual,
          pass: false,
          interruptedByClose: true
        };
      }
      throw error;
    }
  }

  return {
    actual,
    pass: passTextExpectation(actual, expected)
  };
}

expect.extend({
  async toHaveText(received: unknown, expected: TextExpectation) {
    if (!isLocatorLike(received)) {
      return {
        pass: false,
        message: () => "toHaveText expects a Locator-like object."
      };
    }

    try {
      const { actual, pass, interruptedByClose } = await pollLocatorText(received, expected);
      return {
        pass,
        message: () =>
          `expected locator text ${this.isNot ? "not " : ""}to be ${formatExpected(expected)}, received ${formatActual(actual)}`
          + (interruptedByClose ? "\nTarget page, context or browser has been closed" : "")
      };
    } catch (error) {
      if (!isCloseInterruption(error)) {
        throw error;
      }

      return {
        pass: false,
        message: () =>
          `expected locator text ${this.isNot ? "not " : ""}to be ${formatExpected(expected)}, received ${formatActual("")}`
          + "\nTarget page, context or browser has been closed"
      };
    }
  }
});
