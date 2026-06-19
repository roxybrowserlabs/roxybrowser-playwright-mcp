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

  const stdout = await execFileText("ps", ["-eo", "pid=,command="]).catch(() => "");
  const currentPid = process.pid;
  const pids = stdout
    .split("\n")
    .map((line) => {
      const match = line.trim().match(/^(\d+)\s+(.+)$/);
      if (!match) {
        return null;
      }

      const pid = Number(match[1]);
      const command = match[2];
      if (pid === currentPid) {
        return null;
      }

      if (!TEST_BROWSER_PROFILE_MARKERS.some((marker) => command.includes(marker))) {
        return null;
      }

      const normalizedCommand = command.toLowerCase();
      if (!TEST_BROWSER_COMMAND_MARKERS.some((marker) => normalizedCommand.includes(marker))) {
        return null;
      }

      return pid;
    })
    .filter((pid): pid is number => pid !== null);

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
