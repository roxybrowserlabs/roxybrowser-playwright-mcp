import { appendFileSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { firefox } from "../../src/index.js";
import type { Browser, BrowserContext, Page } from "../../src/types/api.js";
import {
  closeRoxyBrowserFirefoxBidiProfile,
  openRoxyBrowserFirefoxBidiProfile
} from "../../scripts/roxybrowser-firefox-bidi.mjs";
import {
  cleanupCurrentWorkerTestBrowserProcesses,
  cleanupCurrentWorkerTestBrowserProcessesSync,
  configureCurrentWorkerTestBrowserCleanup
} from "./browser-process-cleanup.js";

const BIDI_SESSION_ID = process.env.ROXY_BIDI_SESSION_ID;
const ROXYBROWSER_API_PORT = process.env.ROXYBROWSER_API_PORT ?? process.env.ROXY_API_PORT ?? "50000";
const ROXYBROWSER_API_TOKEN = process.env.ROXYBROWSER_API_TOKEN ?? process.env.ROXY_API_TOKEN;
const ROXYBROWSER_WORKSPACE_ID = process.env.ROXYBROWSER_WORKSPACE_ID;
const ROXYBROWSER_PROJECT_ID = process.env.ROXYBROWSER_PROJECT_ID;
const ROXYBROWSER_PROFILE_ID = process.env.ROXYBROWSER_PROFILE_ID;
const ROXYBROWSER_PROFILE_NAME = process.env.ROXYBROWSER_PROFILE_NAME ?? "RoxyBrowser Firefox BiDi E2E";
const ROXYBROWSER_PROFILE_MATCH = process.env.ROXYBROWSER_PROFILE_MATCH ?? "firefox";
const ROXYBROWSER_CORE_VERSION = process.env.ROXYBROWSER_CORE_VERSION ?? "146";
const ROXYBROWSER_DEBUG = process.env.ROXYBROWSER_DEBUG === "1";
const REUSE_BIDI_BROWSER = process.env.ROXY_BIDI_REUSE_BROWSER !== "0";
const TEST_CLOSE_TIMEOUT_MS = 5_000;
const SIGNAL_EXIT_GRACE_MS = Number(process.env.ROXY_TEST_BROWSER_SIGNAL_EXIT_GRACE_MS ?? 20_000);

interface BidiTestState {
  browser: Browser | undefined;
  browserKey: string | undefined;
  roxyProfileDirId: string | undefined;
  roxyProfileWasCreated: boolean;
  cleanupPromise: Promise<void> | undefined;
}

function bidiTestState(): BidiTestState {
  const state = globalThis as typeof globalThis & {
    __roxyBidiTestState?: BidiTestState;
  };
  state.__roxyBidiTestState ??= {
    browser: undefined,
    browserKey: undefined,
    roxyProfileDirId: undefined,
    roxyProfileWasCreated: false,
    cleanupPromise: undefined
  };
  return state.__roxyBidiTestState;
}

function workerLabel(): string {
  return process.env.VITEST_POOL_ID ?? "main";
}

function workerWindowRemark(): string {
  return `firefox bidi e2e worker-${workerLabel()}`;
}

function workerProfileName(): string {
  return `${ROXYBROWSER_PROFILE_NAME} [worker ${workerLabel()}]`;
}

function assertRoxyBrowserBidiEnvironment(): void {
  if (!ROXYBROWSER_API_TOKEN) {
    throw new Error(
      "BiDi e2e now requires RoxyBrowser. Set ROXYBROWSER_API_TOKEN or ROXY_API_TOKEN."
    );
  }
}

// Each `pool: "forks"` worker runs in its own OS process and normally holds a
// single reused RoxyBrowser profile for its whole lifetime (see
// REUSE_BIDI_BROWSER). That profile is only released via crash/signal
// handlers inside the *same* process (installBidiTestCleanupHooks) or when a
// worker itself opts out of reuse. A worker that simply finishes its last
// test never releases its profile, and the main vitest process (where
// bidi.global-setup.ts's teardown runs) never created one itself, so its own
// cleanupExternalBidiTestState() call is a no-op for worker-created
// profiles. Left unaddressed, every successful `pnpm test:e2e:bidi` run
// leaks one RoxyBrowser profile per worker until the account's window quota
// is exhausted. This on-disk registry lets each worker record profiles it
// creates so the main process can sweep and delete them once the whole run
// finishes, regardless of whether any individual worker released its own.
const BIDI_PROFILE_REGISTRY_FILENAME_PATTERN = /^roxybrowser-bidi-profile-registry-.+\.jsonl$/;

function currentWorkerBidiProfileRegistryPath(): string {
  return join(tmpdir(), `roxybrowser-bidi-profile-registry-${workerLabel()}-${process.pid}.jsonl`);
}

function recordCreatedRoxyBrowserProfile(dirId: string): void {
  try {
    appendFileSync(currentWorkerBidiProfileRegistryPath(), `${JSON.stringify({ dirId })}\n`);
  } catch {
    // Best-effort bookkeeping only: a missed entry just means the
    // end-of-run orphan sweep won't catch this specific profile.
  }
}

function forgetCreatedRoxyBrowserProfile(dirId: string): void {
  const registryPath = currentWorkerBidiProfileRegistryPath();
  let text: string;
  try {
    text = readFileSync(registryPath, "utf8");
  } catch {
    return;
  }

  const remainingLines = text.split("\n").filter((line) => {
    if (!line.trim()) {
      return false;
    }
    try {
      return (JSON.parse(line) as { dirId?: unknown }).dirId !== dirId;
    } catch {
      return true;
    }
  });

  try {
    if (remainingLines.length) {
      writeFileSync(registryPath, `${remainingLines.join("\n")}\n`);
    } else {
      rmSync(registryPath, { force: true });
    }
  } catch {
    // Best-effort: a stale entry left behind is harmless — the end-of-run
    // sweep will attempt to delete it again, and RoxyBrowser profile
    // deletion is idempotent against an already-deleted dirId.
  }
}

/**
 * Deletes every RoxyBrowser profile recorded by any worker's on-disk
 * registry, then removes the registry files. Intended to run once, from the
 * main vitest process, after all workers have finished (see
 * bidi.global-setup.ts) — it is not part of any individual worker's own
 * open/close lifecycle.
 */
export async function cleanupOrphanedRoxyBrowserProfiles(): Promise<void> {
  if (!ROXYBROWSER_API_TOKEN) {
    return;
  }

  let entries: string[];
  try {
    entries = readdirSync(tmpdir());
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!BIDI_PROFILE_REGISTRY_FILENAME_PATTERN.test(entry)) {
      continue;
    }

    const registryPath = join(tmpdir(), entry);
    let text: string;
    try {
      text = readFileSync(registryPath, "utf8");
    } catch {
      continue;
    }

    for (const line of text.split("\n")) {
      if (!line.trim()) {
        continue;
      }

      let dirId: unknown;
      try {
        dirId = (JSON.parse(line) as { dirId?: unknown }).dirId;
      } catch {
        continue;
      }

      if (typeof dirId !== "string" || !dirId) {
        continue;
      }

      await closeRoxyBrowserFirefoxBidiProfile({
        apiPort: ROXYBROWSER_API_PORT,
        apiToken: ROXYBROWSER_API_TOKEN,
        workspaceId: ROXYBROWSER_WORKSPACE_ID,
        dirId,
        deleteProfile: true
      });
    }

    rmSync(registryPath, { force: true });
  }
}

async function openWorkerScopedRoxyBrowserSession(): Promise<{
  dirId: string;
  endpoint: string;
  created?: boolean;
  sessionId?: string;
}> {
  assertRoxyBrowserBidiEnvironment();
  return openRoxyBrowserFirefoxBidiProfile({
    apiPort: ROXYBROWSER_API_PORT,
    apiToken: ROXYBROWSER_API_TOKEN,
    workspaceId: ROXYBROWSER_WORKSPACE_ID,
    projectId: ROXYBROWSER_PROJECT_ID,
    ...(ROXYBROWSER_PROFILE_ID ? { profileId: ROXYBROWSER_PROFILE_ID } : { createNewProfile: true }),
    profileName: workerProfileName(),
    profileMatch: ROXYBROWSER_PROFILE_MATCH,
    coreType: "Firefox",
    coreVersion: ROXYBROWSER_CORE_VERSION,
    windowRemark: workerWindowRemark(),
    debug: ROXYBROWSER_DEBUG,
    os: process.env.ROXYBROWSER_OS ?? "macOS",
    osVersion: process.env.ROXYBROWSER_OS_VERSION
  });
}

function shouldReuseBidiBrowser(): boolean {
  return REUSE_BIDI_BROWSER;
}

export async function openBidiBrowser(): Promise<Browser> {
  configureCurrentWorkerTestBrowserCleanup();
  const state = bidiTestState();
  await state.cleanupPromise;

  if (shouldReuseBidiBrowser() && state.browser) {
    return state.browser;
  }

  if (!shouldReuseBidiBrowser()) {
    await cleanupStaleBidiTestArtifacts();
  }

  const session = await openWorkerScopedRoxyBrowserSession();
  state.roxyProfileDirId = session.dirId;
  state.roxyProfileWasCreated = Boolean(session.created);
  if (session.created) {
    recordCreatedRoxyBrowserProfile(session.dirId);
  }
  const sessionId = BIDI_SESSION_ID ?? session.sessionId;
  const browserKey = `${session.dirId}:${session.endpoint}:${sessionId ?? ""}`;
  let browser: Browser | undefined;
  try {
    browser = await firefox.connect(session.endpoint, {
      ...(sessionId ? { sessionId } : {})
    });
  } catch (error) {
    await cleanupStaleBidiTestArtifacts();
    const message = String(error instanceof Error ? error.message : error);
    if (!message.includes("Maximum number of active BiDi sessions")) {
      throw error;
    }
    const retriedSession = await openWorkerScopedRoxyBrowserSession();
    state.roxyProfileDirId = retriedSession.dirId;
    state.roxyProfileWasCreated = Boolean(retriedSession.created);
    if (retriedSession.created) {
      recordCreatedRoxyBrowserProfile(retriedSession.dirId);
    }
    const retriedSessionId = BIDI_SESSION_ID ?? retriedSession.sessionId;
    browser = await firefox.connect(retriedSession.endpoint, {
      ...(retriedSessionId ? { sessionId: retriedSessionId } : {})
    });
  }

  if (shouldReuseBidiBrowser()) {
    state.browser = browser;
    state.browserKey = browserKey;
  }

  return browser;
}

export async function withBidiPage<T>(
  run: (page: Page, context: BrowserContext, browser: Browser) => Promise<T>
): Promise<T> {
  const shouldReuseBrowser = shouldReuseBidiBrowser();
  let browser = await openBidiBrowser();
  let context: BrowserContext | undefined;

  try {
    context = browser.contexts()[0] ?? await browser.newContext({ reuseDefaultUserContext: true });
  } catch (error) {
    if (!isRecoverableBidiBrowserError(error)) {
      throw error;
    }

    await cleanupExternalBidiTestState();
    browser = await openBidiBrowser();
    context = browser.contexts()[0] ?? await browser.newContext({ reuseDefaultUserContext: true });
  }

  try {
    const page = await context.newPage();

    try {
      return await run(page, context, browser);
    } finally {
      await closeForTest("page.close", () => page.close()).catch(() => {});
    }
  } finally {
    await closeForTest("context.close", () => context.close()).catch(() => {});
    if (!shouldReuseBrowser) {
      await closeForTest("browser.close", () => browser.close()).catch(() => {});
      await cleanupStaleBidiTestArtifacts();
    }
  }
}

function isClosedBidiConnectionError(error: unknown): boolean {
  return String(error instanceof Error ? error.message : error).includes(
    "WebDriver BiDi connection is closed."
  );
}

function isRecoverableBidiBrowserError(error: unknown): boolean {
  const message = String(error instanceof Error ? error.message : error);
  return (
    isClosedBidiConnectionError(error)
    || message.includes("Target page, context or browser has been closed")
    || message.includes("Session closed")
  );
}

async function cleanupStaleBidiTestArtifacts(): Promise<void> {
  const state = bidiTestState();
  const runCleanup = async () => {
    const dirId = state.roxyProfileDirId;
    const deleteProfile = state.roxyProfileWasCreated;
    state.roxyProfileDirId = undefined;
    state.roxyProfileWasCreated = false;
    const hadTrackedArtifacts = Boolean(dirId);
    if (dirId) {
      await closeRoxyBrowserFirefoxBidiProfile({
        apiPort: ROXYBROWSER_API_PORT,
        apiToken: ROXYBROWSER_API_TOKEN,
        workspaceId: ROXYBROWSER_WORKSPACE_ID,
        dirId,
        deleteProfile
      });
      if (deleteProfile) {
        forgetCreatedRoxyBrowserProfile(dirId);
      }
    }
    if (hadTrackedArtifacts || !shouldReuseBidiBrowser()) {
      await cleanupCurrentWorkerTestBrowserProcesses();
    }
    if (hadTrackedArtifacts) {
      await delay(250);
    }
  };

  const cleanup = (state.cleanupPromise ?? Promise.resolve()).then(runCleanup, runCleanup);
  state.cleanupPromise = cleanup.finally(() => {
    if (state.cleanupPromise === cleanup) {
      state.cleanupPromise = undefined;
    }
  });
  await state.cleanupPromise;
}

export async function cleanupExternalBidiTestState(): Promise<void> {
  const state = bidiTestState();
  const browser = state.browser;
  state.browser = undefined;
  state.browserKey = undefined;

  if (browser) {
    await closeForTest("browser.close", () => browser.close()).catch(() => {});
  }

  await cleanupStaleBidiTestArtifacts();
}

export async function cleanupBidiTestStateAfterTest(): Promise<void> {
  if (!shouldReuseBidiBrowser()) {
    return;
  }

  await delay(0);
}

export async function cleanupLocalBidiTestProcesses(): Promise<void> {
  await cleanupCurrentWorkerTestBrowserProcesses();
}

export function installBidiTestCleanupHooks(): void {
  const state = globalThis as typeof globalThis & {
    __roxyBidiTestCleanupHooksInstalled?: boolean;
  };
  if (state.__roxyBidiTestCleanupHooksInstalled) {
    return;
  }
  state.__roxyBidiTestCleanupHooksInstalled = true;

  process.once("exit", () => {
    cleanupCurrentWorkerTestBrowserProcessesSync();
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      const exitCode = signal === "SIGINT" ? 130 : 143;
      const fallback = setTimeout(() => {
        process.exit(exitCode);
      }, SIGNAL_EXIT_GRACE_MS);

      void cleanupExternalBidiTestState()
        .catch(() => {})
        .finally(() => {
          clearTimeout(fallback);
          process.exit(exitCode);
        });
    });
  }

  process.once("uncaughtException", (error) => {
    const fallback = setTimeout(() => {
      throw error;
    }, SIGNAL_EXIT_GRACE_MS);

    void cleanupExternalBidiTestState()
      .catch(() => {})
      .finally(() => {
        clearTimeout(fallback);
        setTimeout(() => {
          throw error;
        }, 0);
      });
  });

  process.once("unhandledRejection", (reason) => {
    const fallback = setTimeout(() => {
      throw reason;
    }, SIGNAL_EXIT_GRACE_MS);

    void cleanupExternalBidiTestState()
      .catch(() => {})
      .finally(() => {
        clearTimeout(fallback);
        setTimeout(() => {
          throw reason;
        }, 0);
      });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function closeForTest(label: string, close: () => Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      close(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} timed out after ${TEST_CLOSE_TIMEOUT_MS}ms.`));
        }, TEST_CLOSE_TIMEOUT_MS);
      })
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export function __resetBidiTestStateForUnitTests(): void {
  const state = globalThis as typeof globalThis & {
    __roxyBidiTestCleanupHooksInstalled?: boolean;
    __roxyBidiTestState?: BidiTestState;
  };
  state.__roxyBidiTestState = undefined;
  state.__roxyBidiTestCleanupHooksInstalled = undefined;
}
