import { execFile, spawnSync } from "node:child_process";
import {
  cleanupRegisteredTestBrowserProcesses,
  cleanupRegisteredTestBrowserProcessesSync
} from "../../src/processCleanup.js";

process.env.ROXY_TEST_BROWSER_CLEANUP = "1";

const TEST_BROWSER_PROFILE_MARKERS = [
  "roxybrowser-bidi-",
  "roxybrowser-cdp-"
];

const TEST_BROWSER_COMMAND_MARKERS = [
  "firefox",
  "--remote-debugging-port=",
  "chromium",
  "chrome"
];
const CLEANUP_TIMEOUT_MS = Number(process.env.ROXY_TEST_BROWSER_CLEANUP_TIMEOUT_MS ?? 5_000);
const SIGNAL_EXIT_GRACE_MS = Number(process.env.ROXY_TEST_BROWSER_SIGNAL_EXIT_GRACE_MS ?? 20_000);
let cleanupPromise: Promise<void> | undefined;

export async function cleanupLocalTestBrowserProcesses(): Promise<void> {
  if (process.platform === "win32") {
    return;
  }

  cleanupPromise ??= cleanupLocalTestBrowserProcessesOnce().finally(() => {
    cleanupPromise = undefined;
  });
  await cleanupPromise;
}

export async function cleanupLocalTestBrowserProcessesWithTimeout(): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      cleanupLocalTestBrowserProcesses(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`Local test browser cleanup timed out after ${CLEANUP_TIMEOUT_MS}ms.`));
        }, CLEANUP_TIMEOUT_MS);
      })
    ]);
  } catch {
    cleanupLocalTestBrowserProcessesSync();
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function cleanupLocalTestBrowserProcessesOnce(): Promise<void> {
  await cleanupRegisteredTestBrowserProcesses();

  const stdout = await execFileText("ps", ["-eo", "pid=,ppid=,command="]).catch(() => "");
  const processTree = collectLocalTestBrowserProcessTree(stdout, process.pid);
  await terminateLocalTestBrowserProcessPids(processTree);
}

export function cleanupLocalTestBrowserProcessesSync(): void {
  if (process.platform === "win32") {
    return;
  }

  cleanupRegisteredTestBrowserProcessesSync();

  const result = spawnSync("ps", ["-eo", "pid=,ppid=,command="], {
    encoding: "utf8"
  });
  const stdout = typeof result?.stdout === "string" ? result.stdout : "";
  const processTree = collectLocalTestBrowserProcessTree(stdout, process.pid);

  for (const pid of processTree.rootPids) {
    killProcessGroup(pid, "SIGTERM");
  }
  for (const pid of processTree.pids) {
    killPid(pid, "SIGTERM");
  }
  for (const pid of processTree.rootPids) {
    killProcessGroup(pid, "SIGKILL");
  }
  for (const pid of processTree.pids) {
    killPid(pid, "SIGKILL");
  }
}

export function installLocalTestBrowserProcessCleanupHooks(): void {
  const state = globalThis as typeof globalThis & {
    __roxyBrowserProcessCleanupHooksInstalled?: boolean;
  };
  if (state.__roxyBrowserProcessCleanupHooksInstalled) {
    return;
  }
  state.__roxyBrowserProcessCleanupHooksInstalled = true;

  process.once("exit", () => {
    cleanupLocalTestBrowserProcessesSync();
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      cleanupLocalTestBrowserProcessesSync();
      scheduleProcessExit(signal === "SIGINT" ? 130 : 143);
    });
  }

  process.once("uncaughtException", (error) => {
    cleanupLocalTestBrowserProcessesSync();
    scheduleThrow(error);
  });

  process.once("unhandledRejection", (reason) => {
    cleanupLocalTestBrowserProcessesSync();
    scheduleThrow(reason);
  });
}

export function collectLocalTestBrowserProcessTreePids(
  stdout: string,
  currentPid: number
): number[] {
  return collectLocalTestBrowserProcessTree(stdout, currentPid).pids;
}

export function collectLocalTestBrowserProcessTree(
  stdout: string,
  currentPid: number
): LocalTestBrowserProcessTree {
  const processes = stdout
    .split("\n")
    .map((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
      if (!match) {
        return null;
      }

      const pid = Number(match[1]);
      const ppid = Number(match[2]);
      const command = match[3];
      if (pid === currentPid) {
        return null;
      }

      return { pid, ppid, command };
    })
    .filter((process): process is ProcessInfo => process !== null);
  const childrenByParentPid = new Map<number, ProcessInfo[]>();
  for (const process of processes) {
    const children = childrenByParentPid.get(process.ppid) ?? [];
    children.push(process);
    childrenByParentPid.set(process.ppid, children);
  }
  const rootPids = processes.filter(isLocalTestBrowserProcess).map((process) => process.pid);
  const pids = [...collectProcessTreePids(rootPids, childrenByParentPid)]
    .filter((pid) => pid !== currentPid);

  return {
    rootPids,
    pids
  };
}

async function terminateLocalTestBrowserProcessPids(
  processTree: LocalTestBrowserProcessTree
): Promise<void> {
  const { rootPids, pids } = processTree;

  for (const pid of rootPids) {
    killProcessGroup(pid, "SIGTERM");
  }
  for (const pid of pids) {
    killPid(pid, "SIGTERM");
  }

  if (!pids.length) {
    return;
  }

  await delay(500);
  for (const pid of rootPids) {
    killProcessGroup(pid, "SIGKILL");
  }
  for (const pid of pids) {
    killPid(pid, "SIGKILL");
  }
}

export interface LocalTestBrowserProcessTree {
  rootPids: number[];
  pids: number[];
}

interface ProcessInfo {
  pid: number;
  ppid: number;
  command: string;
}

function isLocalTestBrowserProcess(process: ProcessInfo): boolean {
  if (!TEST_BROWSER_PROFILE_MARKERS.some((marker) => process.command.includes(marker))) {
    return false;
  }

  const normalizedCommand = process.command.toLowerCase();
  return TEST_BROWSER_COMMAND_MARKERS.some((marker) => normalizedCommand.includes(marker));
}

function collectProcessTreePids(
  rootPids: number[],
  childrenByParentPid: Map<number, ProcessInfo[]>
): Set<number> {
  const pids = new Set<number>();
  const queue = [...rootPids];

  while (queue.length) {
    const pid = queue.shift()!;
    if (pids.has(pid)) {
      continue;
    }

    pids.add(pid);
    for (const child of childrenByParentPid.get(pid) ?? []) {
      queue.push(child.pid);
    }
  }

  return pids;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function killPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // The process may have exited between listing and cleanup.
  }
}

function killProcessGroup(pid: number, signal: NodeJS.Signals): void {
  if (process.platform === "win32") {
    return;
  }

  try {
    process.kill(-pid, signal);
  } catch {
    // The browser may not have its own process group, or it may already be gone.
  }
}

function execFileText(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

function scheduleProcessExit(code: number): void {
  process.exitCode = code;
  setTimeout(() => {
    process.exit(code);
  }, SIGNAL_EXIT_GRACE_MS);
}

function scheduleThrow(reason: unknown): void {
  setTimeout(() => {
    throw reason;
  }, SIGNAL_EXIT_GRACE_MS);
}
