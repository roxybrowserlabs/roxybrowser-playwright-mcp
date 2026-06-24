import { accessSync, constants as fsConstants } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const DEFAULT_OUTPUT_DIRNAME = ".roxybrowser-mcp";

export type OutputOptions = {
  cwd?: string;
  outputDir?: string;
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
