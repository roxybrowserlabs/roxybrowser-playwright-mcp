import type { BrowserContextOptions } from "../types/options.js";

export type McpBrowserFamily = "chromium" | "firefox" | "webkit";

type DeviceDescriptor = Pick<
  BrowserContextOptions,
  "deviceScaleFactor" | "hasTouch" | "isMobile" | "screen" | "userAgent" | "viewport"
>;

const deviceDescriptors: Record<string, DeviceDescriptor> = {
  "iPhone 15": {
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5 Mobile/15E148 Safari/604.1",
    screen: { width: 393, height: 852 },
    viewport: { width: 393, height: 659 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true
  },
  "iPhone 17": {
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5 Mobile/15E148 Safari/604.1",
    screen: { width: 402, height: 874 },
    viewport: { width: 402, height: 681 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true
  },
  "Pixel 10": {
    userAgent: "Mozilla/5.0 (Linux; Android 16; Pixel 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.7922.34 Mobile Safari/537.36",
    screen: { width: 360, height: 808 },
    viewport: { width: 360, height: 732 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true
  }
};

export function resolveMcpDeviceContextOptions(options: {
  browserName?: McpBrowserFamily;
  device?: string;
  mobile?: boolean;
  viewport?: { width: number; height: number };
}): BrowserContextOptions | undefined {
  let device = options.device;
  const browserName = options.browserName ?? "chromium";
  if (options.mobile) {
    if (device) {
      throw new Error("Cannot use --mobile together with --device, pick one.");
    }
    if (browserName === "firefox") {
      throw new Error("--mobile is not supported with the Firefox browser.");
    }
    device = browserName === "webkit" ? "iPhone 17" : "Pixel 10";
  }

  const descriptor = device ? deviceDescriptors[device] : undefined;
  if (!descriptor && !options.viewport) {
    return undefined;
  }

  return {
    ...(descriptor ?? {}),
    ...(options.viewport !== undefined ? { viewport: options.viewport } : {})
  };
}
