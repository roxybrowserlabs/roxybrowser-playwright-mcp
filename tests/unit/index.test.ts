import { describe, expect, it } from "vitest";
import * as library from "../../src/index.js";

describe("index exports", () => {
  it("exports the chromium browser type", () => {
    expect(library.chromium).toBeDefined();
  });

  it("exports the firefox browser type", () => {
    expect(library.firefox).toBeDefined();
  });
});
