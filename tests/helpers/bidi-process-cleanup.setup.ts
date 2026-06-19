import { afterAll } from "vitest";
import { cleanupExternalBidiTestState } from "./bidi.js";

afterAll(async () => {
  await cleanupExternalBidiTestState();
});
