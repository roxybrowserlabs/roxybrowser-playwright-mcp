import { execFile } from "node:child_process";

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

export async function cleanupLocalTestBrowserProcesses(): Promise<void> {
  if (process.platform === "win32") {
    return;
  }

  const stdout = await execFileText("ps", ["-eo", "pid=,ppid=,command="]).catch(() => "");
  const currentPid = process.pid;
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
  const rootPids = processes
    .filter(isLocalTestBrowserProcess)
    .map((process) => process.pid);
  const pids = [...collectProcessTreePids(rootPids, childrenByParentPid)]
    .filter((pid) => pid !== currentPid);

  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // The process may have exited between listing and cleanup.
    }
  }

  if (!pids.length) {
    return;
  }

  await delay(500);
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone, which is the desired state.
    }
  }
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
