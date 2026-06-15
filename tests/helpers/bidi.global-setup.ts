import { cleanupExternalBidiTestState } from "./bidi.js";

export default async function globalSetup() {
  return async () => {
    await cleanupExternalBidiTestState();
  };
}
