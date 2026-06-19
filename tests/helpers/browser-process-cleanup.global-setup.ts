import { cleanupLocalTestBrowserProcessesWithTimeout } from "./browser-process-cleanup.js";

export default async function globalSetup() {
  await cleanupLocalTestBrowserProcessesWithTimeout();

  return async () => {
    await cleanupLocalTestBrowserProcessesWithTimeout();
  };
}
