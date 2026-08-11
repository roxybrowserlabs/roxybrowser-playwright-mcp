import type { BrowserContextOptions } from "../types/options.js";

type CdpEmulationClient = {
  Emulation?: {
    setDeviceMetricsOverride(options: {
      mobile: boolean;
      width: number;
      height: number;
      screenWidth: number;
      screenHeight: number;
      deviceScaleFactor: number;
      screenOrientation: { angle: number; type: "landscapePrimary" | "portraitPrimary" };
    }): Promise<void>;
    setTouchEmulationEnabled?(options: { enabled: boolean }): Promise<void>;
    setUserAgentOverride?(options: { userAgent: string }): Promise<void>;
  };
  Security?: {
    setIgnoreCertificateErrors?(options: { ignore: boolean }): Promise<void>;
  };
};

type CdpBrowserPermission =
  | "geolocation"
  | "midi"
  | "notifications"
  | "videoCapture"
  | "audioCapture"
  | "backgroundSync"
  | "sensors"
  | "clipboardReadWrite"
  | "clipboardSanitizedWrite"
  | "paymentHandler"
  | "midiSysex"
  | "storageAccess"
  | "localFonts"
  | "localNetworkAccess"
  | "localNetwork"
  | "loopbackNetwork"
  | "wakeLockScreen";

type CdpBrowserEmulationClient = {
  Browser?: {
    grantPermissions?(options: {
      permissions: CdpBrowserPermission[];
      origin?: string;
      browserContextId?: string;
    }): Promise<void>;
  };
};

type BidiEmulationClient = {
  browsingContextSetViewport(params: {
    context: string;
    viewport: { width: number; height: number };
  }): Promise<unknown>;
  emulationSetUserAgentOverride(params: {
    userAgent: string;
    contexts: string[];
  }): Promise<unknown>;
};

type CdpContextEmulationOptions = {
  browserClient?: CdpBrowserEmulationClient;
  browserContextId?: string;
};

const CDP_WEB_PERMISSION_TO_PROTOCOL = new Map<string, CdpBrowserPermission | CdpBrowserPermission[]>([
  ["geolocation", "geolocation"],
  ["midi", "midi"],
  ["notifications", "notifications"],
  ["camera", "videoCapture"],
  ["microphone", "audioCapture"],
  ["background-sync", "backgroundSync"],
  ["ambient-light-sensor", "sensors"],
  ["accelerometer", "sensors"],
  ["gyroscope", "sensors"],
  ["magnetometer", "sensors"],
  ["clipboard-read", "clipboardReadWrite"],
  ["clipboard-write", "clipboardSanitizedWrite"],
  ["payment-handler", "paymentHandler"],
  ["midi-sysex", "midiSysex"],
  ["storage-access", "storageAccess"],
  ["local-fonts", "localFonts"],
  ["local-network-access", ["localNetworkAccess", "localNetwork", "loopbackNetwork"]],
  ["screen-wake-lock", "wakeLockScreen"]
]);

export async function emulateCdpContext(
  client: CdpEmulationClient,
  options: BrowserContextOptions,
  emulationOptions: CdpContextEmulationOptions = {}
): Promise<void> {
  if (options.viewport) {
    const viewport = options.viewport;
    const screen = options.screen ?? viewport;
    const isLandscape = screen.width > screen.height;
    await client.Emulation?.setDeviceMetricsOverride({
      mobile: Boolean(options.isMobile),
      width: viewport.width,
      height: viewport.height,
      screenWidth: screen.width,
      screenHeight: screen.height,
      deviceScaleFactor: options.deviceScaleFactor ?? 1,
      screenOrientation: Boolean(options.isMobile)
        ? isLandscape
          ? { angle: 90, type: "landscapePrimary" }
          : { angle: 0, type: "portraitPrimary" }
        : { angle: 0, type: "landscapePrimary" }
    });
  }

  if (options.hasTouch !== undefined) {
    await client.Emulation?.setTouchEmulationEnabled?.({ enabled: options.hasTouch });
  }

  if (options.userAgent) {
    await client.Emulation?.setUserAgentOverride?.({ userAgent: options.userAgent });
  }

  if (options.ignoreHTTPSErrors) {
    await client.Security?.setIgnoreCertificateErrors?.({ ignore: true });
  }

  if (options.permissions !== undefined) {
    await grantCdpPermissions(options.permissions, emulationOptions);
  }
}

async function grantCdpPermissions(
  permissions: string[],
  emulationOptions: CdpContextEmulationOptions
): Promise<void> {
  const protocolPermissions = permissions.flatMap((permission) => {
    const protocolPermission = CDP_WEB_PERMISSION_TO_PROTOCOL.get(permission);
    if (!protocolPermission) {
      throw new Error(`Unknown permission: ${permission}`);
    }
    return typeof protocolPermission === "string" ? [protocolPermission] : protocolPermission;
  });

  await emulationOptions.browserClient?.Browser?.grantPermissions?.({
    permissions: protocolPermissions,
    ...(emulationOptions.browserContextId !== undefined ? { browserContextId: emulationOptions.browserContextId } : {})
  });
}

export async function emulateBidiContext(
  client: BidiEmulationClient,
  contextId: string,
  options: BrowserContextOptions
): Promise<void> {
  if (options.viewport) {
    await client.browsingContextSetViewport({
      context: contextId,
      viewport: options.viewport
    });
  }

  if (options.userAgent) {
    await client.emulationSetUserAgentOverride({
      userAgent: options.userAgent,
      contexts: [contextId]
    });
  }

  // ⚠️ DIVERGENCE FROM PLAYWRIGHT: Firefox BiDi currently exposes viewport and
  // user-agent overrides in this already-connected MCP session layer, but not
  // Chromium-equivalent deviceScaleFactor / screen / isMobile / touch emulation
  // or browser-session creation options such as acceptInsecureCerts. Keep those
  // fields in the shared context options so CDP remains Playwright-aligned, and
  // expand this branch when BiDi protocol support is available.
}
