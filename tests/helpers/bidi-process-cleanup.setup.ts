import { afterAll, afterEach } from "vitest";
import { cleanupBidiTestStateAfterTest, cleanupExternalBidiTestState } from "./bidi.js";

afterEach(async () => {
  await cleanupBidiTestStateAfterTest();
});

afterAll(async () => {
  await cleanupExternalBidiTestState();
});
