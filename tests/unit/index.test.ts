import { describe, expect, it } from "vitest";
import * as library from "../../src/index.js";

describe("index exports", () => {
  it("exports the chromium browser type", () => {
    expect(library.chromium).toBeDefined();
  });
});
