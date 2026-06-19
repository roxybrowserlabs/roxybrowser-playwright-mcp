import { afterAll, afterEach } from "vitest";
import {
  cleanupLocalTestBrowserProcessesWithTimeout,
  installLocalTestBrowserProcessCleanupHooks
} from "./browser-process-cleanup.js";

installLocalTestBrowserProcessCleanupHooks();

afterEach(async () => {
  await cleanupLocalTestBrowserProcessesWithTimeout();
});

afterAll(async () => {
  await cleanupLocalTestBrowserProcessesWithTimeout();
});
