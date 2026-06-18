import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { chromium } from "../../../src/index.js";
import type { Browser, BrowserContext, Page } from "../../../src/types/api.js";
import type { BrowserContextOptions } from "../../../src/types/options.js";
import { withPage } from "../../helpers/browser.js";

describe("page screencast recording contract e2e", () => {
  it("writes a recording file when path is provided", async () => {
    const directory = await mkdtemp(join(tmpdir(), "roxy-screencast-recording-"));
    const ffmpegPath = await createFakeFfmpeg(directory);
    const outputPath = join(directory, "video.webm");
    const previousFfmpegPath = process.env.ROXY_FFMPEG_PATH;
    process.env.ROXY_FFMPEG_PATH = ffmpegPath;

    try {
      await withPage(async (page) => {
        await page.setViewportSize({ width: 640, height: 360 });

        const recording = await page.screencast.start({
          path: outputPath,
          size: {
            width: 320,
            height: 180
          }
        });
        await page.goto("data:text/html,<body style='margin:0;background:white'></body>");
        await page.evaluate(`() => {
          document.body.style.backgroundColor = "red";
        }`);
        await new Promise((resolve) => setTimeout(resolve, 500));
        await recording.dispose();
      });

      expect((await stat(outputPath)).size).toBeGreaterThan(0);
      const buffer = await readFile(outputPath);
      expect(buffer[0]).toBe(0xff);
      expect(buffer[1]).toBe(0xd8);
    } finally {
      if (previousFfmpegPath === undefined) {
        delete process.env.ROXY_FFMPEG_PATH;
      } else {
        process.env.ROXY_FFMPEG_PATH = previousFfmpegPath;
      }
    }
  });

  it("allows manual screencast recording when recordVideo is enabled", async () => {
    const directory = await mkdtemp(join(tmpdir(), "roxy-screencast-recording-"));
    const ffmpegPath = await createFakeFfmpeg(directory);
    const autoDir = join(directory, "auto");
    const manualPath = join(directory, "manual", "video.webm");
    const previousFfmpegPath = process.env.ROXY_FFMPEG_PATH;
    process.env.ROXY_FFMPEG_PATH = ffmpegPath;

    try {
      await withPageWithContextOptions(
        {
          recordVideo: {
            dir: autoDir
          }
        },
        async (page, context) => {
          const manualRecording = await page.screencast.start({
            path: manualPath
          });
          await page.goto("data:text/html,<body style='margin:0;background:white'></body>");
          await page.evaluate(`() => {
            document.body.style.backgroundColor = "blue";
          }`);
          await new Promise((resolve) => setTimeout(resolve, 500));
          await manualRecording.dispose();
          await context.close();
        }
      );

      expect((await stat(manualPath)).size).toBeGreaterThan(0);
      expect((await readFile(manualPath))[0]).toBe(0xff);
      const autoVideos = await readDirectoryWebm(autoDir);
      expect(autoVideos).toHaveLength(1);
    } finally {
      if (previousFfmpegPath === undefined) {
        delete process.env.ROXY_FFMPEG_PATH;
      } else {
        process.env.ROXY_FFMPEG_PATH = previousFfmpegPath;
      }
    }
  });
});

async function createFakeFfmpeg(directory: string): Promise<string> {
  const ffmpegPath = join(directory, "fake-ffmpeg.sh");
  await writeFile(
    ffmpegPath,
    "#!/bin/sh\nout=\"\"\nfor arg in \"$@\"; do out=\"$arg\"; done\ncat > \"$out\"\n"
  );
  await chmod(ffmpegPath, 0o755);
  return ffmpegPath;
}

async function withPageWithContextOptions(
  contextOptions: BrowserContextOptions,
  run: (page: Page, context: BrowserContext, browser: Browser) => Promise<void>
): Promise<void> {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.ROXY_E2E_EXECUTABLE_PATH
      ? { executablePath: process.env.ROXY_E2E_EXECUTABLE_PATH }
      : {})
  });

  try {
    const context = await browser.newContext(contextOptions);
    try {
      const page = await context.newPage();
      await run(page, context, browser);
    } finally {
      await context.close().catch(() => {});
    }
  } finally {
    await browser.close();
  }
}

async function readDirectoryWebm(directory: string): Promise<string[]> {
  try {
    const { readdir } = await import("node:fs/promises");
    return (await readdir(directory)).filter((entry) => entry.endsWith(".webm"));
  } catch {
    return [];
  }
}
