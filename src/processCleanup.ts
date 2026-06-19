import { execFile } from "node:child_process";
import type { ChildProcess } from "node:child_process";

const DEFAULT_CLOSE_TIMEOUT_MS = 5_000;

export async function terminateProcessTree(
  proc: Pick<ChildProcess, "pid" | "kill" | "once"> | undefined,
  options: {
    timeoutMs?: number;
  } = {}
): Promise<void> {
  if (!proc) {
    return;
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
  const rootPid = proc.pid;
  const pids = rootPid
    ? [...new Set([rootPid, ...(await collectDescendantPids(rootPid))])]
    : [];

  await waitForProcessExit(proc, timeoutMs, () => {
    signalProcessGroupOrTree(rootPid, pids, "SIGTERM", proc);
  });

  for (const pid of [...pids].reverse()) {
    killPid(pid, "SIGKILL");
  }
}

async function waitForProcessExit(
  proc: Pick<ChildProcess, "kill" | "once">,
  timeoutMs: number,
  requestExit: () => void
): Promise<void> {
  await new Promise<void>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (settled) {
        return;
      }

      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      resolve();
    };

    proc.once("exit", finish);
    proc.once("close", finish);
    proc.once("error", finish);

    try {
      requestExit();
    } catch {
      finish();
      return;
    }

    timer = setTimeout(finish, timeoutMs);
  });
}

function signalProcessGroupOrTree(
  rootPid: number | undefined,
  pids: number[],
  signal: NodeJS.Signals,
  proc: Pick<ChildProcess, "kill">
): void {
  if (rootPid && process.platform !== "win32") {
    try {
      process.kill(-rootPid, signal);
      return;
    } catch {
      // The browser may not have its own process group, or it may already be gone.
    }
  }

  if (pids.length) {
    for (const pid of [...pids].reverse()) {
      killPid(pid, signal);
    }
    return;
  }

  try {
    proc.kill(signal);
  } catch {
    // The process may have failed to spawn or already exited.
  }
}

function killPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // The process may have exited between discovery and cleanup.
  }
}

async function collectDescendantPids(rootPid: number): Promise<number[]> {
  if (process.platform === "win32") {
    return [];
  }

  const stdout = await execFileText("ps", ["-eo", "pid=,ppid="]).catch(() => "");
  const childrenByParent = new Map<number, number[]>();
  for (const line of stdout.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (!match) {
      continue;
    }

    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const children = childrenByParent.get(ppid) ?? [];
    children.push(pid);
    childrenByParent.set(ppid, children);
  }

  const descendants: number[] = [];
  const queue = [...(childrenByParent.get(rootPid) ?? [])];
  while (queue.length) {
    const pid = queue.shift()!;
    descendants.push(pid);
    queue.push(...(childrenByParent.get(pid) ?? []));
  }
  return descendants;
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
