import { accessSync, constants as fsConstants } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const DEFAULT_OUTPUT_DIRNAME = ".roxybrowser-playwright-mcp";
export type OutputOptions = {
  cwd?: string;
  outputDir?: string;
};

export type TempOptions = {
  tempDir?: string;
};

export function configuredOutputDir(options: OutputOptions = {}): string {
  const cwd = options.cwd ?? process.cwd();
  const configured =
    options.outputDir
    ?? process.env.ROXY_MCP_OUTPUT_DIR
    ?? process.env.PLAYWRIGHT_MCP_OUTPUT_DIR;

  if (configured) {
    return path.resolve(configured);
  }

  if (isSystemDirectory(cwd) || !isWritable(cwd)) {
    return path.join(tmpdir(), DEFAULT_OUTPUT_DIRNAME);
  }

  return path.join(cwd, DEFAULT_OUTPUT_DIRNAME);
}

export function configuredTempDir(options: TempOptions = {}): string {
  const configured =
    options.tempDir
    ?? process.env.ROXY_MCP_TEMP_DIR
    ?? process.env.PLAYWRIGHT_MCP_TEMP_DIR;

  if (configured) {
    return path.resolve(configured);
  }

  return tmpdir();
}

export async function resolveOutputFilePath(
  filename: string,
  options: OutputOptions = {}
): Promise<string> {
  const resolved = path.isAbsolute(filename)
    ? filename
    : path.resolve(configuredOutputDir(options), filename);
  await mkdir(path.dirname(resolved), { recursive: true });
  return resolved;
}

export async function resolveTempFilePath(
  filename: string,
  options: TempOptions = {}
): Promise<string> {
  const resolved = path.isAbsolute(filename)
    ? filename
    : path.resolve(configuredTempDir(options), filename);
  await mkdir(path.dirname(resolved), { recursive: true });
  return resolved;
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
