import { accessSync, constants as fsConstants } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  AssetKind,
  AssetOptions,
  AssetPolicy,
  AssetRoots,
  ResolveAssetRootsOptions,
  ResolvedAsset
} from "./types.js";

const DEFAULT_ARTIFACTS_DIRNAME = "roxybrowser-playwright-artifacts";

const KIND_DIR_NAMES: Record<Exclude<AssetKind, "temporary">, string> = {
  download: "downloads",
  screenshot: "screenshots",
  snapshot: "snapshots",
  trace: "traces",
  video: "videos",
  network: "network",
  console: "console",
  script: "scripts"
};

const ENV_BY_ROOT = {
  artifactsDir: "ROXY_PLAYWRIGHT_ARTIFACTS_DIR",
  downloadsDir: "ROXY_PLAYWRIGHT_DOWNLOADS_DIR",
  screenshotsDir: "ROXY_PLAYWRIGHT_SCREENSHOTS_DIR",
  snapshotsDir: "ROXY_PLAYWRIGHT_SNAPSHOTS_DIR",
  tracesDir: "ROXY_PLAYWRIGHT_TRACES_DIR",
  videosDir: "ROXY_PLAYWRIGHT_VIDEOS_DIR",
  networkDir: "ROXY_PLAYWRIGHT_NETWORK_DIR",
  consoleDir: "ROXY_PLAYWRIGHT_CONSOLE_DIR",
  scriptsDir: "ROXY_PLAYWRIGHT_SCRIPTS_DIR",
  tempDir: "ROXY_PLAYWRIGHT_TEMP_DIR"
} as const;

export class AssetManager {
  readonly roots: AssetRoots;
  readonly policy: AssetPolicy;

  constructor(options: AssetOptions & { cwd?: string } = {}, policy: Partial<AssetPolicy> = {}) {
    this.roots = resolveAssetRoots(options);
    this.policy = {
      allowAbsolutePaths: options.allowAbsoluteAssetPaths ?? policy.allowAbsolutePaths ?? false,
      allowSystemDirectories: policy.allowSystemDirectories ?? false,
      collisionStrategy: policy.collisionStrategy ?? "increment"
    };
    validateAssetRoots(this.roots, this.policy);
  }

  rootFor(kind: AssetKind): string {
    switch (kind) {
      case "download":
        return this.roots.downloadsDir;
      case "screenshot":
        return this.roots.screenshotsDir;
      case "snapshot":
        return this.roots.snapshotsDir;
      case "trace":
        return this.roots.tracesDir;
      case "video":
        return this.roots.videosDir;
      case "network":
        return this.roots.networkDir;
      case "console":
        return this.roots.consoleDir;
      case "script":
        return this.roots.scriptsDir;
      case "temporary":
        return this.roots.tempDir;
    }
  }

  async resolveFile(kind: AssetKind, filename: string): Promise<ResolvedAsset> {
    const root = this.rootFor(kind);
    const candidate = filename.trim() || sanitizeAssetFilename(defaultFilename(kind));
    const resolved = path.isAbsolute(candidate)
      ? this.resolveAbsolutePath(candidate)
      : path.resolve(root, normalizeRelativeFilename(candidate));

    const finalPath = await this.resolveCollision(resolved);
    await mkdir(path.dirname(finalPath), { recursive: true });
    return {
      absolutePath: finalPath,
      relativePath: path.relative(this.roots.artifactsDir, finalPath) || path.basename(finalPath),
      kind
    };
  }

  private resolveAbsolutePath(filename: string): string {
    if (!this.policy.allowAbsolutePaths) {
      throw new Error(`Absolute asset paths are disabled: ${filename}`);
    }
    return path.resolve(filename);
  }

  private async resolveCollision(filename: string): Promise<string> {
    if (this.policy.collisionStrategy === "error") {
      if (await pathExists(filename)) {
        throw new Error(`Asset file already exists: ${filename}`);
      }
      return filename;
    }
    if (this.policy.collisionStrategy === "timestamp") {
      if (!(await pathExists(filename))) {
        return filename;
      }
      const parsed = path.parse(filename);
      return path.join(parsed.dir, `${parsed.name}-${Date.now()}${parsed.ext}`);
    }

    if (!(await pathExists(filename))) {
      return filename;
    }

    const parsed = path.parse(filename);
    for (let index = 1; index < 10_000; index += 1) {
      const candidate = path.join(parsed.dir, `${parsed.name}-${index}${parsed.ext}`);
      if (!(await pathExists(candidate))) {
        return candidate;
      }
    }
    throw new Error(`Unable to find available asset filename for ${filename}`);
  }
}

export function resolveAssetRoots(options: ResolveAssetRootsOptions = {}): AssetRoots {
  const sandboxOutputDir = process.env.SANDBOX_OUTPUT_DIR;
  const hasExplicitArtifactsDir = options.artifactsDir !== undefined;
  const artifactsDir = resolveRoot(
    options.artifactsDir
      ?? process.env[ENV_BY_ROOT.artifactsDir]
      ?? sandboxOutputDir
      ?? defaultArtifactsDir(options.cwd)
  );
  const sandboxAsFlatRoot = Boolean(sandboxOutputDir && !hasExplicitArtifactsDir && !process.env[ENV_BY_ROOT.artifactsDir]);

  return {
    artifactsDir,
    downloadsDir: resolveKindRoot({
      explicitRoot: hasExplicitArtifactsDir,
      optionValue: options.downloadsDir,
      envValue: process.env[ENV_BY_ROOT.downloadsDir],
      artifactsDir,
      subdir: KIND_DIR_NAMES.download,
      sandboxValue: sandboxAsFlatRoot ? sandboxOutputDir : undefined
    }),
    screenshotsDir: resolveKindRoot({
      explicitRoot: hasExplicitArtifactsDir,
      optionValue: options.screenshotsDir,
      envValue: process.env[ENV_BY_ROOT.screenshotsDir],
      artifactsDir,
      subdir: KIND_DIR_NAMES.screenshot
    }),
    snapshotsDir: resolveKindRoot({
      explicitRoot: hasExplicitArtifactsDir,
      optionValue: options.snapshotsDir,
      envValue: process.env[ENV_BY_ROOT.snapshotsDir],
      artifactsDir,
      subdir: KIND_DIR_NAMES.snapshot
    }),
    tracesDir: resolveKindRoot({
      explicitRoot: hasExplicitArtifactsDir,
      optionValue: options.tracesDir,
      envValue: process.env[ENV_BY_ROOT.tracesDir],
      artifactsDir,
      subdir: KIND_DIR_NAMES.trace
    }),
    videosDir: resolveKindRoot({
      explicitRoot: hasExplicitArtifactsDir,
      optionValue: options.videosDir,
      envValue: process.env[ENV_BY_ROOT.videosDir],
      artifactsDir,
      subdir: KIND_DIR_NAMES.video
    }),
    networkDir: resolveKindRoot({
      explicitRoot: hasExplicitArtifactsDir,
      optionValue: options.networkDir,
      envValue: process.env[ENV_BY_ROOT.networkDir],
      artifactsDir,
      subdir: KIND_DIR_NAMES.network
    }),
    consoleDir: resolveKindRoot({
      explicitRoot: hasExplicitArtifactsDir,
      optionValue: options.consoleDir,
      envValue: process.env[ENV_BY_ROOT.consoleDir],
      artifactsDir,
      subdir: KIND_DIR_NAMES.console
    }),
    scriptsDir: resolveKindRoot({
      explicitRoot: hasExplicitArtifactsDir,
      optionValue: options.scriptsDir,
      envValue: process.env[ENV_BY_ROOT.scriptsDir],
      artifactsDir,
      subdir: KIND_DIR_NAMES.script,
      sandboxValue: sandboxAsFlatRoot ? sandboxOutputDir : undefined
    }),
    tempDir: resolveKindRoot({
      explicitRoot: hasExplicitArtifactsDir,
      optionValue: options.tempDir,
      envValue: process.env[ENV_BY_ROOT.tempDir],
      artifactsDir,
      subdir: "tmp"
    })
  };
}

function resolveKindRoot(options: {
  artifactsDir: string;
  envValue?: string | undefined;
  explicitRoot: boolean;
  optionValue?: string | undefined;
  sandboxValue?: string | undefined;
  subdir: string;
}): string {
  return resolveRoot(
    options.optionValue
      ?? (options.explicitRoot ? path.join(options.artifactsDir, options.subdir) : undefined)
      ?? options.envValue
      ?? options.sandboxValue
      ?? path.join(options.artifactsDir, options.subdir)
  );
}

export function sanitizeAssetFilename(filename: string): string {
  const basename = path.basename(filename).trim();
  const sanitized = basename
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-")
    .replace(/^\.+/, "")
    .trim();
  return sanitized || "asset";
}

function normalizeRelativeFilename(filename: string): string {
  const normalized = path.normalize(filename).replace(/^(\.\.(\/|\\|$))+/, "");
  const parts = normalized.split(/[\\/]+/).filter((part) => part && part !== "." && part !== "..");
  if (!parts.length) {
    return "asset";
  }
  const last = parts.pop()!;
  return path.join(...parts, sanitizeAssetFilename(last));
}

function defaultFilename(kind: AssetKind): string {
  return `${kind}-${new Date().toISOString().replaceAll(":", "-")}`;
}

function defaultArtifactsDir(cwd = process.cwd()): string {
  const base = isSystemDirectory(cwd) || !isWritable(cwd)
    ? tmpdir()
    : cwd;
  return path.join(base, DEFAULT_ARTIFACTS_DIRNAME);
}

function resolveRoot(root: string): string {
  return path.resolve(root);
}

function validateAssetRoots(roots: AssetRoots, policy: AssetPolicy): void {
  for (const root of new Set(Object.values(roots))) {
    if (!policy.allowSystemDirectories && isSystemDirectory(root)) {
      throw new Error(`Asset root cannot point to a system directory: ${root}`);
    }
    const nearest = nearestExistingDirectory(root);
    if (!isWritable(nearest)) {
      throw new Error(`Asset root is not writable: ${root}`);
    }
  }
}

function nearestExistingDirectory(target: string): string {
  let current = path.resolve(target);
  while (!pathExistsSync(current)) {
    const next = path.dirname(current);
    if (next === current) {
      return current;
    }
    current = next;
  }
  return current;
}

function isSystemDirectory(dir: string): boolean {
  const resolved = path.resolve(dir);
  return resolved === path.parse(resolved).root;
}

function isWritable(dir: string): boolean {
  try {
    accessSync(dir, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function pathExistsSync(target: string): boolean {
  try {
    accessSync(target, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function pathExists(target: string): Promise<boolean> {
  return Boolean(await stat(target).catch(() => undefined));
}
