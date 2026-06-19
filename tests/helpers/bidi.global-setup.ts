import { cleanupExternalBidiTestState } from "./bidi.js";

export default async function globalSetup() {
  await cleanupExternalBidiTestState();

  return async () => {
    await cleanupExternalBidiTestState();
  };
}
