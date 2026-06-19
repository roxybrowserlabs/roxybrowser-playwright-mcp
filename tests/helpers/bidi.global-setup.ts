import { cleanupLocalBidiTestProcesses } from "./bidi.js";

export default async function globalSetup() {
  await cleanupLocalBidiTestProcesses();

  return async () => {
    await cleanupLocalBidiTestProcesses();
  };
}
