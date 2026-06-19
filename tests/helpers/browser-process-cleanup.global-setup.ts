import { cleanupLocalTestBrowserProcesses } from "./browser-process-cleanup.js";

export default async function globalSetup() {
  await cleanupLocalTestBrowserProcesses();

  return async () => {
    await cleanupLocalTestBrowserProcesses();
  };
}
