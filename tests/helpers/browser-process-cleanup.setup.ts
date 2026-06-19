import { afterAll } from "vitest";
import { installLocalTestBrowserProcessCleanupHooks } from "./browser-process-cleanup.js";
import { cleanupLocalTestBrowserProcesses } from "./browser-process-cleanup.js";

installLocalTestBrowserProcessCleanupHooks();

afterAll(async () => {
  await cleanupLocalTestBrowserProcesses();
});
