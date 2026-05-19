import type { SupportedProtocol } from "../types/options.js";

export interface ProtocolCapabilities {
  protocol: SupportedProtocol;
  supportsMultipleContexts: boolean;
  supportsIsolatedWorlds: boolean;
  supportsLocatorChaining: boolean;
  supportsInputDispatch: boolean;
  supportsDownloads: boolean;
  supportsTracing: boolean;
}

