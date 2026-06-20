import { execFile, spawnSync } from "node:child_process";
import { appendFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ChildProcess } from "node:child_process";

const DEFAULT_CLOSE_TIMEOUT_MS = 5_000;
const TEST_BROWSER_CLEANUP_ENV = "ROXY_TEST_BROWSER_CLEANUP";
const TEST_BROWSER_PROCESS_REGISTRY_ENV = "ROXY_TEST_BROWSER_PROCESS_REGISTRY";
const DEFAULT_TEST_BROWSER_PROCESS_REGISTRY = join(
  tmpdir(),
  "roxybrowser-test-browser-processes.jsonl"
);

const registeredTestBrowserProcesses = new Set<RegisteredTestBrowserProcess>();

interface RegisteredTestBrowserProcess {
  proc: Pick<ChildProcess, "pid" | "kill" | "once">;
  userDataDir?: string;
}

interface PersistedTestBrowserProcess {
  pid: number;
  userDataDir?: string;
}

export function registerTestBrowserProcessForCleanup(
  proc: Pick<ChildProcess, "pid" | "kill" | "once">,
  userDataDir?: string
): () => void {
  if (process.env[TEST_BROWSER_CLEANUP_ENV] !== "1") {
    return () => {};
  }

  const entry: RegisteredTestBrowserProcess = {
    proc,
    ...(userDataDir ? { userDataDir } : {})
  };
  registeredTestBrowserProcesses.add(entry);
  persistTestBrowserProcess(entry);
  return () => {
    registeredTestBrowserProcesses.delete(entry);
    removePersistedTestBrowserProcess(entry);
  };
}

export async function cleanupRegisteredTestBrowserProcesses(): Promise<void> {
  const entries = [...registeredTestBrowserProcesses];
  const persistedEntries = readPersistedTestBrowserProcessesSync();
  registeredTestBrowserProcesses.clear();
  writePersistedTestBrowserProcessesSync([]);

  for (const entry of entries) {
    await terminateProcessTree(entry.proc, { timeoutMs: 500 }).catch(() => {});
    if (entry.userDataDir) {
      await rm(entry.userDataDir, { force: true, recursive: true }).catch(() => {});
    }
  }
  for (const entry of persistedEntries) {
    await terminatePersistedTestBrowserProcess(entry).catch(() => {});
    if (entry.userDataDir) {
      await rm(entry.userDataDir, { force: true, recursive: true }).catch(() => {});
    }
  }
}

export function cleanupRegisteredTestBrowserProcessesSync(): void {
  const entries = [...registeredTestBrowserProcesses];
  const persistedEntries = readPersistedTestBrowserProcessesSync();
  registeredTestBrowserProcesses.clear();
  writePersistedTestBrowserProcessesSync([]);

  for (const entry of entries) {
    terminateProcessTreeSync(entry.proc);
    if (entry.userDataDir) {
      try {
        rmSync(entry.userDataDir, { force: true, recursive: true });
      } catch {
        // Best-effort cleanup for process-exit paths.
      }
    }
  }
  for (const entry of persistedEntries) {
    terminatePersistedTestBrowserProcessSync(entry);
    if (entry.userDataDir) {
      try {
        rmSync(entry.userDataDir, { force: true, recursive: true });
      } catch {
        // Best-effort cleanup for process-exit paths.
      }
    }
  }
}

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

function terminateProcessTreeSync(proc: Pick<ChildProcess, "pid" | "kill">): void {
  const rootPid = proc.pid;
  const pids = rootPid
    ? [...new Set([rootPid, ...collectDescendantPidsSync(rootPid)])]
    : [];

  signalProcessGroupOrTree(rootPid, pids, "SIGTERM", proc);
  for (const pid of [...pids].reverse()) {
    killPid(pid, "SIGKILL");
  }
}

function collectDescendantPidsSync(rootPid: number): number[] {
  if (process.platform === "win32") {
    return [];
  }

  const result = spawnSync("ps", ["-eo", "pid=,ppid="], {
    encoding: "utf8"
  });
  const stdout = typeof result.stdout === "string" ? result.stdout : "";
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

async function terminatePersistedTestBrowserProcess(
  entry: PersistedTestBrowserProcess
): Promise<void> {
  const processTree = await collectPersistedProcessTree(entry.pid, entry.userDataDir);
  if (!processTree) {
    return;
  }

  signalPidProcessGroupOrTree(entry.pid, processTree.pids, "SIGTERM");
  await delay(500);

  const remainingProcessTree = await collectPersistedProcessTree(entry.pid, entry.userDataDir);
  for (const pid of [...(remainingProcessTree?.pids ?? processTree.pids)].reverse()) {
    killPid(pid, "SIGKILL");
  }
}

function terminatePersistedTestBrowserProcessSync(entry: PersistedTestBrowserProcess): void {
  const processTree = collectPersistedProcessTreeSync(entry.pid, entry.userDataDir);
  if (!processTree) {
    return;
  }

  signalPidProcessGroupOrTree(entry.pid, processTree.pids, "SIGTERM");
  for (const pid of [...processTree.pids].reverse()) {
    killPid(pid, "SIGKILL");
  }
}

async function collectPersistedProcessTree(
  rootPid: number,
  userDataDir: string | undefined
): Promise<{ pids: number[] } | undefined> {
  const stdout = await execFileText("ps", ["-eo", "pid=,ppid=,command="]).catch(() => "");
  return collectPersistedProcessTreeFromPs(stdout, rootPid, userDataDir);
}

function collectPersistedProcessTreeSync(
  rootPid: number,
  userDataDir: string | undefined
): { pids: number[] } | undefined {
  const result = spawnSync("ps", ["-eo", "pid=,ppid=,command="], {
    encoding: "utf8"
  });
  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  return collectPersistedProcessTreeFromPs(stdout, rootPid, userDataDir);
}

function collectPersistedProcessTreeFromPs(
  stdout: string,
  rootPid: number,
  userDataDir: string | undefined
): { pids: number[] } | undefined {
  const processes = parseProcessInfos(stdout);
  const root = processes.find((process) => process.pid === rootPid);
  if (!root || !isPersistedTestBrowserRoot(root.command, userDataDir)) {
    return undefined;
  }

  const childrenByParentPid = new Map<number, ProcessInfo[]>();
  for (const process of processes) {
    const children = childrenByParentPid.get(process.ppid) ?? [];
    children.push(process);
    childrenByParentPid.set(process.ppid, children);
  }

  return {
    pids: [...collectProcessTreePids([rootPid], childrenByParentPid)]
  };
}

function signalPidProcessGroupOrTree(
  rootPid: number,
  pids: number[],
  signal: NodeJS.Signals
): void {
  if (process.platform !== "win32") {
    try {
      process.kill(-rootPid, signal);
      return;
    } catch {
      // The browser may not have its own process group, or it may already be gone.
    }
  }

  for (const pid of [...pids].reverse()) {
    killPid(pid, signal);
  }
}

interface ProcessInfo {
  pid: number;
  ppid: number;
  command: string;
}

function parseProcessInfos(stdout: string): ProcessInfo[] {
  return stdout
    .split("\n")
    .map((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
      if (!match) {
        return null;
      }

      return {
        pid: Number(match[1]),
        ppid: Number(match[2]),
        command: match[3]
      };
    })
    .filter((process): process is ProcessInfo => process !== null);
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

function isPersistedTestBrowserRoot(command: string, userDataDir: string | undefined): boolean {
  if (userDataDir && !command.includes(userDataDir)) {
    return false;
  }

  const normalizedCommand = command.toLowerCase();
  return (
    (normalizedCommand.includes("firefox") || normalizedCommand.includes("chrom")) &&
    (
      normalizedCommand.includes("--remote-debugging-port=") ||
      normalizedCommand.includes("roxybrowser-bidi-") ||
      normalizedCommand.includes("roxybrowser-cdp-")
    )
  );
}

async function readPersistedTestBrowserProcesses(): Promise<PersistedTestBrowserProcess[]> {
  return readPersistedTestBrowserProcessesSync();
}

function readPersistedTestBrowserProcessesSync(): PersistedTestBrowserProcess[] {
  try {
    return parsePersistedTestBrowserProcesses(readFileSync(testBrowserProcessRegistryPath(), "utf8"));
  } catch {
    return [];
  }
}

function parsePersistedTestBrowserProcesses(text: string): PersistedTestBrowserProcess[] {
  const processes = new Map<string, PersistedTestBrowserProcess>();
  for (const line of text.split("\n")) {
    if (!line.trim()) {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    if (!parsed || typeof parsed !== "object") {
      continue;
    }

    const process = parsed as Partial<PersistedTestBrowserProcess>;
    const pid = process.pid;
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
      continue;
    }

    const entry: PersistedTestBrowserProcess = {
      pid,
      ...(typeof process.userDataDir === "string" ? { userDataDir: process.userDataDir } : {})
    };
    processes.set(persistedTestBrowserProcessKey(entry), entry);
  }
  return [...processes.values()];
}

async function writePersistedTestBrowserProcesses(
  processes: PersistedTestBrowserProcess[]
): Promise<void> {
  writePersistedTestBrowserProcessesSync(processes);
}

function writePersistedTestBrowserProcessesSync(processes: PersistedTestBrowserProcess[]): void {
  try {
    writeFileSync(testBrowserProcessRegistryPath(), serializePersistedTestBrowserProcesses(processes));
  } catch {
    // Best-effort cleanup registry maintenance.
  }
}

function serializePersistedTestBrowserProcesses(processes: PersistedTestBrowserProcess[]): string {
  return processes.map((process) => JSON.stringify(process)).join("\n");
}

function persistTestBrowserProcess(entry: RegisteredTestBrowserProcess): void {
  if (!entry.proc.pid) {
    return;
  }

  try {
    appendFileSync(
      testBrowserProcessRegistryPath(),
      `${JSON.stringify({
        pid: entry.proc.pid,
        ...(entry.userDataDir ? { userDataDir: entry.userDataDir } : {})
      })}\n`
    );
  } catch {
    // The in-memory registry still covers normal test teardown.
  }
}

function removePersistedTestBrowserProcess(entry: RegisteredTestBrowserProcess): void {
  if (!entry.proc.pid) {
    return;
  }

  const key = persistedTestBrowserProcessKey({
    pid: entry.proc.pid,
    ...(entry.userDataDir ? { userDataDir: entry.userDataDir } : {})
  });
  writePersistedTestBrowserProcessesSync(
    readPersistedTestBrowserProcessesSync().filter(
      (process) => persistedTestBrowserProcessKey(process) !== key
    )
  );
}

function persistedTestBrowserProcessKey(process: PersistedTestBrowserProcess): string {
  return `${process.pid}:${process.userDataDir ?? ""}`;
}

function testBrowserProcessRegistryPath(): string {
  return process.env[TEST_BROWSER_PROCESS_REGISTRY_ENV] ?? DEFAULT_TEST_BROWSER_PROCESS_REGISTRY;
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
