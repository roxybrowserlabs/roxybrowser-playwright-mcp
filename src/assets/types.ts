export type AssetKind =
  | "download"
  | "screenshot"
  | "snapshot"
  | "trace"
  | "video"
  | "network"
  | "console"
  | "script"
  | "temporary";

export interface AssetRoots {
  artifactsDir: string;
  downloadsDir: string;
  screenshotsDir: string;
  snapshotsDir: string;
  tracesDir: string;
  videosDir: string;
  networkDir: string;
  consoleDir: string;
  scriptsDir: string;
  tempDir: string;
}

export interface AssetOptions {
  artifactsDir?: string;
  downloadsDir?: string;
  screenshotsDir?: string;
  snapshotsDir?: string;
  tracesDir?: string;
  videosDir?: string;
  networkDir?: string;
  consoleDir?: string;
  scriptsDir?: string;
  tempDir?: string;
  allowAbsoluteAssetPaths?: boolean;
}

export interface AssetPolicy {
  allowAbsolutePaths: boolean;
  allowSystemDirectories: boolean;
  collisionStrategy: "increment" | "timestamp" | "error";
}

export interface ResolveAssetRootsOptions extends AssetOptions {
  cwd?: string;
}

export interface ResolvedAsset {
  absolutePath: string;
  relativePath: string;
  kind: AssetKind;
}
