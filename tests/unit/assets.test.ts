import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AssetManager,
  resolveAssetRoots,
  sanitizeAssetFilename
} from "../../src/assets/manager.js";
import { RoxyArtifact } from "../../src/artifact.js";

const cleanupPaths: string[] = [];

afterEach(async () => {
  delete process.env.ROXY_PLAYWRIGHT_ARTIFACTS_DIR;
  delete process.env.ROXY_PLAYWRIGHT_DOWNLOADS_DIR;
  delete process.env.ROXY_PLAYWRIGHT_SCREENSHOTS_DIR;
  delete process.env.ROXY_PLAYWRIGHT_SNAPSHOTS_DIR;
  delete process.env.ROXY_PLAYWRIGHT_TRACES_DIR;
  delete process.env.ROXY_PLAYWRIGHT_VIDEOS_DIR;
  delete process.env.ROXY_PLAYWRIGHT_NETWORK_DIR;
  delete process.env.ROXY_PLAYWRIGHT_CONSOLE_DIR;
  delete process.env.ROXY_PLAYWRIGHT_SCRIPTS_DIR;
  delete process.env.ROXY_PLAYWRIGHT_TEMP_DIR;
  delete process.env.SANDBOX_OUTPUT_DIR;
  delete process.env.ROXY_MCP_OUTPUT_DIR;
  delete process.env.PLAYWRIGHT_MCP_OUTPUT_DIR;
  delete process.env.ROXY_MCP_TEMP_DIR;
  delete process.env.PLAYWRIGHT_MCP_TEMP_DIR;

  while (cleanupPaths.length) {
    const target = cleanupPaths.pop();
    if (target) {
      await rm(target, { recursive: true, force: true }).catch(() => undefined);
    }
  }
});

describe("asset roots", () => {
  it("derives all durable roots from artifactsDir", async () => {
    const artifactsDir = await mkdtemp(path.join(tmpdir(), "roxy-assets-root-"));
    cleanupPaths.push(artifactsDir);

    expect(resolveAssetRoots({ artifactsDir })).toEqual({
      artifactsDir,
      downloadsDir: path.join(artifactsDir, "downloads"),
      screenshotsDir: path.join(artifactsDir, "screenshots"),
      snapshotsDir: path.join(artifactsDir, "snapshots"),
      tracesDir: path.join(artifactsDir, "traces"),
      videosDir: path.join(artifactsDir, "videos"),
      networkDir: path.join(artifactsDir, "network"),
      consoleDir: path.join(artifactsDir, "console"),
      scriptsDir: path.join(artifactsDir, "scripts"),
      tempDir: path.join(artifactsDir, "tmp")
    });
  });

  it("uses kind-specific API options before artifactsDir", async () => {
    const artifactsDir = await mkdtemp(path.join(tmpdir(), "roxy-assets-root-"));
    const downloadsDir = await mkdtemp(path.join(tmpdir(), "roxy-assets-downloads-"));
    cleanupPaths.push(artifactsDir, downloadsDir);

    expect(resolveAssetRoots({ artifactsDir, downloadsDir }).downloadsDir).toBe(downloadsDir);
  });

  it("uses explicit artifactsDir before kind-specific environment defaults", async () => {
    const artifactsDir = await mkdtemp(path.join(tmpdir(), "roxy-assets-root-"));
    const envDownloadsDir = await mkdtemp(path.join(tmpdir(), "roxy-assets-env-downloads-"));
    cleanupPaths.push(artifactsDir, envDownloadsDir);
    process.env.ROXY_PLAYWRIGHT_DOWNLOADS_DIR = envDownloadsDir;

    expect(resolveAssetRoots({ artifactsDir }).downloadsDir)
      .toBe(path.join(artifactsDir, "downloads"));
  });

  it("uses ROXY_PLAYWRIGHT environment defaults", async () => {
    const artifactsDir = await mkdtemp(path.join(tmpdir(), "roxy-assets-env-"));
    const downloadsDir = await mkdtemp(path.join(tmpdir(), "roxy-assets-env-downloads-"));
    cleanupPaths.push(artifactsDir, downloadsDir);
    process.env.ROXY_PLAYWRIGHT_ARTIFACTS_DIR = artifactsDir;
    process.env.ROXY_PLAYWRIGHT_DOWNLOADS_DIR = downloadsDir;

    const roots = resolveAssetRoots();

    expect(roots.artifactsDir).toBe(artifactsDir);
    expect(roots.downloadsDir).toBe(downloadsDir);
    expect(roots.snapshotsDir).toBe(path.join(artifactsDir, "snapshots"));
  });

  it("uses SANDBOX_OUTPUT_DIR as the default asset root", async () => {
    const sandboxDir = await mkdtemp(path.join(tmpdir(), "roxy-assets-sandbox-"));
    cleanupPaths.push(sandboxDir);
    process.env.SANDBOX_OUTPUT_DIR = sandboxDir;

    const roots = resolveAssetRoots();

    expect(roots.artifactsDir).toBe(sandboxDir);
    expect(roots.downloadsDir).toBe(sandboxDir);
    expect(roots.scriptsDir).toBe(sandboxDir);
    expect(roots.snapshotsDir).toBe(path.join(sandboxDir, "snapshots"));
  });

  it("ignores removed MCP-specific environment variables", async () => {
    const oldOutput = await mkdtemp(path.join(tmpdir(), "roxy-old-output-"));
    const oldTemp = await mkdtemp(path.join(tmpdir(), "roxy-old-temp-"));
    cleanupPaths.push(oldOutput, oldTemp);
    process.env.ROXY_MCP_OUTPUT_DIR = oldOutput;
    process.env.PLAYWRIGHT_MCP_OUTPUT_DIR = oldOutput;
    process.env.ROXY_MCP_TEMP_DIR = oldTemp;
    process.env.PLAYWRIGHT_MCP_TEMP_DIR = oldTemp;

    const roots = resolveAssetRoots({ cwd: oldOutput });

    expect(roots.artifactsDir).not.toBe(oldOutput);
    expect(roots.tempDir).not.toBe(oldTemp);
  });
});

describe("AssetManager", () => {
  it("resolves relative files under the requested asset kind root", async () => {
    const artifactsDir = await mkdtemp(path.join(tmpdir(), "roxy-assets-file-"));
    cleanupPaths.push(artifactsDir);
    const manager = new AssetManager({ artifactsDir });

    const resolved = await manager.resolveFile("snapshot", "nested/page.md");

    expect(resolved.absolutePath).toBe(path.join(artifactsDir, "snapshots", "nested", "page.md"));
    expect(resolved.relativePath).toBe(path.join("snapshots", "nested", "page.md"));
  });

  it("rejects absolute asset paths by default", async () => {
    const artifactsDir = await mkdtemp(path.join(tmpdir(), "roxy-assets-absolute-"));
    cleanupPaths.push(artifactsDir);
    const manager = new AssetManager({ artifactsDir });

    await expect(
      manager.resolveFile("screenshot", path.join(tmpdir(), "screen.png"))
    ).rejects.toThrow("Absolute asset paths are disabled");
  });

  it("allows absolute paths when policy opts in", async () => {
    const artifactsDir = await mkdtemp(path.join(tmpdir(), "roxy-assets-absolute-"));
    cleanupPaths.push(artifactsDir);
    const target = path.join(artifactsDir, "outside-name.png");
    const manager = new AssetManager({
      artifactsDir,
      allowAbsoluteAssetPaths: true
    });

    const resolved = await manager.resolveFile("screenshot", target);

    expect(resolved.absolutePath).toBe(target);
  });

  it("increments colliding filenames", async () => {
    const artifactsDir = await mkdtemp(path.join(tmpdir(), "roxy-assets-collision-"));
    cleanupPaths.push(artifactsDir);
    const manager = new AssetManager({ artifactsDir });
    const first = await manager.resolveFile("download", "report.txt");
    await writeFile(first.absolutePath, "first");

    const second = await manager.resolveFile("download", "report.txt");

    expect(second.absolutePath).toBe(path.join(artifactsDir, "downloads", "report-1.txt"));
  });

  it("rejects system directories as roots", () => {
    expect(() => new AssetManager({ artifactsDir: path.parse(process.cwd()).root }))
      .toThrow("Asset root cannot point to a system directory");
  });

  it("rejects non-writable roots", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "roxy-assets-readonly-"));
    cleanupPaths.push(root);
    await chmod(root, 0o500);

    try {
      expect(() => new AssetManager({ artifactsDir: root }))
        .toThrow("Asset root is not writable");
    } finally {
      await chmod(root, 0o700);
    }
  });

  it("sanitizes suggested filenames", () => {
    expect(sanitizeAssetFilename("../unsafe:name?.txt")).toBe("unsafe-name-.txt");
    expect(sanitizeAssetFilename("")).toBe("asset");
  });
});

describe("RoxyArtifact", () => {
  it("waits for unfinished artifacts before saveAs resolves", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "roxy-artifact-"));
    cleanupPaths.push(dir);
    const localPath = path.join(dir, "download.tmp");
    const targetPath = path.join(dir, "download.txt");
    await writeFile(localPath, "hello");
    const artifact = new RoxyArtifact(localPath);
    let saved = false;

    const savePromise = artifact.saveAs(targetPath).then(() => {
      saved = true;
    });
    await Promise.resolve();

    expect(saved).toBe(false);
    await artifact.reportFinished();
    await savePromise;

    expect(saved).toBe(true);
    expect(await readFile(targetPath, "utf8")).toBe("hello");
  });
});
