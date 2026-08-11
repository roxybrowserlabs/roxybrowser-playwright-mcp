export type AssetKind =
  | "download"
  | "screenshot"
  | "snapshot"
  | "trace"
  | "video"
  | "network"
  | "console"
  | "pdf"
  | "storage"
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
  pdfDir: string;
  storageDir: string;
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
  pdfDir?: string;
  storageDir?: string;
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
