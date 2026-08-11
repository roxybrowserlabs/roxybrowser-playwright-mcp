import { appendFile, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BidiClientFactoryOptions, BidiProtocolClient } from "./client.js";

interface FirefoxBidiSessionEntry {
  endpoint: string;
  pid: number;
  sessionId: string;
}

type BidiClientFactory = (options: BidiClientFactoryOptions) => Promise<BidiProtocolClient>;
type ProcessAlivePredicate = (pid: number) => boolean;

let registryPathOverride: string | undefined;
let processAliveOverride: ProcessAlivePredicate | undefined;

export async function cleanupStaleFirefoxBidiSessions(
  clientFactory: BidiClientFactory,
  endpoint?: string
): Promise<void> {
  const canonicalEndpoint = endpoint ? canonicalFirefoxBidiEndpoint(endpoint) : undefined;
  const entries = await readFirefoxBidiSessionEntries();
  if (entries.length === 0) {
    return;
  }

  const retained: FirefoxBidiSessionEntry[] = [];
  for (const entry of entries) {
    if (canonicalEndpoint && canonicalFirefoxBidiEndpoint(entry.endpoint) !== canonicalEndpoint) {
      retained.push(entry);
      continue;
    }
    if (isFirefoxBidiProcessAlive(entry.pid)) {
      retained.push(entry);
      continue;
    }

    try {
      await endRegisteredFirefoxBidiSession(clientFactory, entry);
    } catch {
      retained.push(entry);
    }
  }

  await writeFirefoxBidiSessionEntries(retained);
}

export async function registerOwnedFirefoxBidiSession(entry: {
  endpoint: string;
  sessionId: string;
}): Promise<() => Promise<void>> {
  const registered: FirefoxBidiSessionEntry = {
    endpoint: canonicalFirefoxBidiEndpoint(entry.endpoint),
    pid: process.pid,
    sessionId: entry.sessionId
  };
  await appendFile(firefoxBidiSessionRegistryPath(), `${JSON.stringify(registered)}\n`, "utf8");
  return async () => {
    await unregisterOwnedFirefoxBidiSession(registered);
  };
}

export async function unregisterOwnedFirefoxBidiSession(entry: FirefoxBidiSessionEntry): Promise<void> {
  const entries = await readFirefoxBidiSessionEntries();
  await writeFirefoxBidiSessionEntries(entries.filter((candidate) => (
    candidate.pid !== entry.pid ||
    candidate.endpoint !== entry.endpoint ||
    candidate.sessionId !== entry.sessionId
  )));
}

export function setFirefoxBidiSessionRegistryPathForTests(path: string): void {
  registryPathOverride = path;
}

export function setFirefoxBidiProcessAliveForTests(predicate: ProcessAlivePredicate): void {
  processAliveOverride = predicate;
}

export function resetFirefoxBidiSessionRegistryForTests(): void {
  registryPathOverride = undefined;
  processAliveOverride = undefined;
}

async function endRegisteredFirefoxBidiSession(
  clientFactory: BidiClientFactory,
  entry: FirefoxBidiSessionEntry
): Promise<void> {
  const client = await clientFactory({
    browserName: "firefox",
    webSocketUrl: buildFirefoxBidiSessionEndpoint(entry.endpoint, entry.sessionId)
  });
  try {
    await client.sessionEnd({});
  } finally {
    client.close();
  }
}

async function readFirefoxBidiSessionEntries(): Promise<FirefoxBidiSessionEntry[]> {
  const text = await readFile(firefoxBidiSessionRegistryPath(), "utf8").catch(() => "");
  const entries: FirefoxBidiSessionEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as Partial<FirefoxBidiSessionEntry>;
      if (
        typeof parsed.endpoint === "string" &&
        typeof parsed.pid === "number" &&
        typeof parsed.sessionId === "string"
      ) {
        entries.push({
          endpoint: parsed.endpoint,
          pid: parsed.pid,
          sessionId: parsed.sessionId
        });
      }
    } catch {
      // Ignore malformed registry lines; the registry is best-effort crash recovery.
    }
  }
  return entries;
}

async function writeFirefoxBidiSessionEntries(entries: FirefoxBidiSessionEntry[]): Promise<void> {
  if (entries.length === 0) {
    await rm(firefoxBidiSessionRegistryPath(), { force: true }).catch(() => {});
    return;
  }
  await writeFile(
    firefoxBidiSessionRegistryPath(),
    entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
    "utf8"
  );
}

function firefoxBidiSessionRegistryPath(): string {
  return registryPathOverride ?? join(tmpdir(), "roxybrowser-firefox-bidi-sessions.jsonl");
}

function isFirefoxBidiProcessAlive(pid: number): boolean {
  if (processAliveOverride) {
    return processAliveOverride(pid);
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function buildFirefoxBidiSessionEndpoint(endpoint: string, sessionId: string): string {
  const url = new URL(endpoint);
  url.pathname = `/session/${sessionId}`;
  return url.toString();
}

function canonicalFirefoxBidiEndpoint(endpoint: string): string {
  const url = new URL(endpoint);
  if (url.pathname === "/" || url.pathname === "" || url.pathname === "/session") {
    url.pathname = "/";
  }
  return url.toString();
}
