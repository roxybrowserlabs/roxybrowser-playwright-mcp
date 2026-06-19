import { afterAll, afterEach } from "vitest";
import { installLocalTestBrowserProcessCleanupHooks } from "./browser-process-cleanup.js";
import { cleanupLocalTestBrowserProcesses } from "./browser-process-cleanup.js";

installLocalTestBrowserProcessCleanupHooks();

afterEach(async () => {
  await cleanupLocalTestBrowserProcesses();
});

afterAll(async () => {
  await cleanupLocalTestBrowserProcesses();
});
