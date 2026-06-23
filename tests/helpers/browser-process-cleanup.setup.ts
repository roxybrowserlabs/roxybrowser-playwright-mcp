import { afterAll, afterEach } from "vitest";
import {
  configureCurrentWorkerTestBrowserCleanup,
  cleanupCurrentWorkerTestBrowserProcesses,
  installLocalTestBrowserProcessCleanupHooks
} from "./browser-process-cleanup.js";

configureCurrentWorkerTestBrowserCleanup();
installLocalTestBrowserProcessCleanupHooks();

afterEach(async () => {
  await cleanupCurrentWorkerTestBrowserProcesses();
});

afterAll(async () => {
  await cleanupCurrentWorkerTestBrowserProcesses();
});
