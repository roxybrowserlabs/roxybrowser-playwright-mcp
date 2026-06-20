import {
  cleanupExternalBidiTestState,
  installBidiTestCleanupHooks
} from "./bidi.js";

export default async function globalSetup() {
  installBidiTestCleanupHooks();
  await cleanupExternalBidiTestState();

  return async () => {
    await cleanupExternalBidiTestState();
  };
}
