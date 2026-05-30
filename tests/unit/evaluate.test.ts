import { describe, expect, it } from "vitest";
import { looksLikeFunctionExpression } from "../../src/protocol/evaluate.js";

describe("looksLikeFunctionExpression", () => {
  it("detects arrow and function expressions used by page.evaluate", () => {
    expect(looksLikeFunctionExpression("() => window.location.protocol")).toBe(true);
    expect(looksLikeFunctionExpression("async () => await Promise.resolve(1)")).toBe(true);
    expect(looksLikeFunctionExpression("value => value + 1")).toBe(true);
    expect(looksLikeFunctionExpression("function () { return document.title; }")).toBe(true);
    expect(looksLikeFunctionExpression("async function () { return 1; }")).toBe(true);
  });

  it("does not treat plain expressions as functions", () => {
    expect(looksLikeFunctionExpression("document.title")).toBe(false);
    expect(looksLikeFunctionExpression("window.location.protocol")).toBe(false);
    expect(looksLikeFunctionExpression("({ ok: true })")).toBe(false);
    expect(looksLikeFunctionExpression("")).toBe(false);
  });
});
