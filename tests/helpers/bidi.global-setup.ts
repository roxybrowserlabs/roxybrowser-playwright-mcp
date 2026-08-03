import {
  cleanupExternalBidiTestState,
  cleanupOrphanedRoxyBrowserProfiles,
  installBidiTestCleanupHooks
} from "./bidi.js";

export default async function globalSetup() {
  installBidiTestCleanupHooks();
  await cleanupExternalBidiTestState();
  // Sweep any per-worker RoxyBrowser profile registries left behind by a
  // prior run that crashed before it could clean up after itself.
  await cleanupOrphanedRoxyBrowserProfiles();

  return async () => {
    await cleanupExternalBidiTestState();
    // Each worker process only releases the RoxyBrowser profile it reused
    // for its own lifetime via in-process hooks; this main-process sweep is
    // what actually deletes every worker's profile once the whole run ends.
    await cleanupOrphanedRoxyBrowserProfiles();
  };
}
