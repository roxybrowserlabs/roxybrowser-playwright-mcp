import { afterEach } from "vitest";
import {
  cleanupBidiTestStateAfterTest,
  installBidiTestCleanupHooks
} from "./bidi.js";

installBidiTestCleanupHooks();

afterEach(async () => {
  await cleanupBidiTestStateAfterTest();
});
