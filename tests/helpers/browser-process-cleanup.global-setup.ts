import {
  cleanupLocalTestBrowserProcessesWithTimeout,
  installLocalTestBrowserProcessCleanupHooks
} from "./browser-process-cleanup.js";

export default async function globalSetup() {
  installLocalTestBrowserProcessCleanupHooks();
  await cleanupLocalTestBrowserProcessesWithTimeout();

  return async () => {
    await cleanupLocalTestBrowserProcessesWithTimeout();
  };
}
