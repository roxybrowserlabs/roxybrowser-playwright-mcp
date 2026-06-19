import { afterAll, afterEach } from "vitest";
import {
  cleanupBidiTestStateAfterTest,
  cleanupExternalBidiTestState,
  installBidiTestCleanupHooks
} from "./bidi.js";

installBidiTestCleanupHooks();

afterEach(async () => {
  await cleanupBidiTestStateAfterTest();
});

afterAll(async () => {
  await cleanupExternalBidiTestState();
});
