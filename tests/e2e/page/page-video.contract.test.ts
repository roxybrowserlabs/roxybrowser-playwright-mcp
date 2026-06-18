import { chmod, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { chromium } from "../../../src/index.js";

describe("page video contract e2e", () => {
  it("does not throw without recordVideo.dir", async () => {
    const directory = await mkdtemp(join(tmpdir(), "roxy-page-video-"));
    const ffmpegPath = await createFakeFfmpeg(directory);
    const previousFfmpegPath = process.env.ROXY_FFMPEG_PATH;
    process.env.ROXY_FFMPEG_PATH = ffmpegPath;

    const browser = await chromium.launch({
      headless: true,
      ...(process.env.ROXY_E2E_EXECUTABLE_PATH
        ? { executablePath: process.env.ROXY_E2E_EXECUTABLE_PATH }
        : {})
    });

    try {
      const context = await browser.newContext({
        recordVideo: {}
      });

      try {
        const page = await context.newPage();
        expect(page.video()).not.toBeNull();
        await page.evaluate(`() => {
          document.body.style.backgroundColor = "red";
        }`);
        await page.close();
      } finally {
        await context.close();
      }
    } finally {
      await browser.close();
      if (previousFfmpegPath === undefined) {
        delete process.env.ROXY_FFMPEG_PATH;
      } else {
        process.env.ROXY_FFMPEG_PATH = previousFfmpegPath;
      }
    }
  });

  it("exposes page.video, saveAs and delete for recordVideo contexts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "roxy-page-video-"));
    const ffmpegPath = await createFakeFfmpeg(directory);
    const saveAsPath = join(directory, "saved.webm");
    const previousFfmpegPath = process.env.ROXY_FFMPEG_PATH;
    process.env.ROXY_FFMPEG_PATH = ffmpegPath;

    const browser = await chromium.launch({
      headless: true,
      ...(process.env.ROXY_E2E_EXECUTABLE_PATH
        ? { executablePath: process.env.ROXY_E2E_EXECUTABLE_PATH }
        : {})
    });

    try {
      const context = await browser.newContext({
        recordVideo: {
          dir: directory,
          size: {
            width: 320,
            height: 240
          }
        }
      });

      try {
        const page = await context.newPage();
        const video = page.video();
        expect(video).not.toBeNull();
        const videoPath = await video!.path();
        expect(videoPath).toContain(directory);

        await page.goto("data:text/html,<body style='margin:0;background:white'></body>");
        await page.evaluate(`() => {
          document.body.style.backgroundColor = "red";
        }`);

        const savePromise = video!.saveAs(saveAsPath);
        await page.close();
        await savePromise;

        expect((await stat(saveAsPath)).size).toBeGreaterThan(0);
        const savedBuffer = await readFile(saveAsPath);
        expect(savedBuffer[0]).toBe(0xff);
        expect(savedBuffer[1]).toBe(0xd8);

        await video!.delete();
      } finally {
        await context.close();
      }
    } finally {
      await browser.close();
      if (previousFfmpegPath === undefined) {
        delete process.env.ROXY_FFMPEG_PATH;
      } else {
        process.env.ROXY_FFMPEG_PATH = previousFfmpegPath;
      }
    }
  });

  it("exposes popup video paths in recordVideo contexts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "roxy-page-video-"));
    const ffmpegPath = await createFakeFfmpeg(directory);
    const previousFfmpegPath = process.env.ROXY_FFMPEG_PATH;
    process.env.ROXY_FFMPEG_PATH = ffmpegPath;

    const browser = await chromium.launch({
      headless: true,
      ...(process.env.ROXY_E2E_EXECUTABLE_PATH
        ? { executablePath: process.env.ROXY_E2E_EXECUTABLE_PATH }
        : {})
    });

    try {
      const context = await browser.newContext({
        recordVideo: {
          dir: directory,
          size: {
            width: 320,
            height: 240
          }
        }
      });

      try {
        const page = await context.newPage();
        const [popup] = await Promise.all([
          page.waitForEvent("popup"),
          page.evaluate(`() => {
            window.open("about:blank");
          }`)
        ]);

        expect(page.video()).not.toBeNull();
        expect(popup.video()).not.toBeNull();
        expect(await popup.video()!.path()).toContain(directory);
      } finally {
        await context.close();
      }
    } finally {
      await browser.close();
      if (previousFfmpegPath === undefined) {
        delete process.env.ROXY_FFMPEG_PATH;
      } else {
        process.env.ROXY_FFMPEG_PATH = previousFfmpegPath;
      }
    }
  });

  it("keeps main page video recording alive after a popup closes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "roxy-page-video-"));
    const ffmpegPath = await createFakeFfmpeg(directory);
    const previousFfmpegPath = process.env.ROXY_FFMPEG_PATH;
    process.env.ROXY_FFMPEG_PATH = ffmpegPath;

    const browser = await chromium.launch({
      headless: true,
      ...(process.env.ROXY_E2E_EXECUTABLE_PATH
        ? { executablePath: process.env.ROXY_E2E_EXECUTABLE_PATH }
        : {})
    });

    try {
      const context = await browser.newContext({
        recordVideo: {
          dir: directory,
          size: {
            width: 320,
            height: 240
          }
        }
      });

      try {
        const page = await context.newPage();
        await page.setContent('<a target="_blank" rel="opener" href="about:blank">open popup</a>');

        const [popup] = await Promise.all([
          page.waitForEvent("popup"),
          page.click("a")
        ]);

        const mainVideoPath = await page.video()!.path();
        const popupVideoPath = await popup.video()!.path();
        expect(mainVideoPath).not.toBe(popupVideoPath);

        await popup.close();
        await page.evaluate(`() => {
          document.body.textContent = "main page still alive";
        }`);

        await context.close();

        expect((await stat(mainVideoPath)).size).toBeGreaterThan(0);
        expect((await stat(popupVideoPath)).size).toBeGreaterThan(0);
      } finally {
        await context.close();
      }
    } finally {
      await browser.close();
      if (previousFfmpegPath === undefined) {
        delete process.env.ROXY_FFMPEG_PATH;
      } else {
        process.env.ROXY_FFMPEG_PATH = previousFfmpegPath;
      }
    }
  });

  it("records distinct video files for the main page and popup", async () => {
    const directory = await mkdtemp(join(tmpdir(), "roxy-page-video-"));
    const ffmpegPath = await createFakeFfmpeg(directory);
    const previousFfmpegPath = process.env.ROXY_FFMPEG_PATH;
    process.env.ROXY_FFMPEG_PATH = ffmpegPath;

    const browser = await chromium.launch({
      headless: true,
      ...(process.env.ROXY_E2E_EXECUTABLE_PATH
        ? { executablePath: process.env.ROXY_E2E_EXECUTABLE_PATH }
        : {})
    });

    try {
      const context = await browser.newContext({
        recordVideo: {
          dir: directory,
          size: {
            width: 320,
            height: 240
          }
        }
      });

      try {
        const page = await context.newPage();
        await page.goto("data:text/html,<body><a target='_blank' rel='opener' href='about:blank'>popup</a></body>");

        const [popup] = await Promise.all([
          page.waitForEvent("popup"),
          page.click("a")
        ]);

        const pageVideoPath = await page.video()!.path();
        const popupVideoPath = await popup.video()!.path();
        expect(pageVideoPath).not.toBe(popupVideoPath);

        await popup.evaluate(`() => {
          document.body.textContent = "popup video";
        }`);
        await page.evaluate(`() => {
          document.body.textContent = "main video";
        }`);

        await context.close();

        const videoFiles = (await readdir(directory)).filter((file) => file.endsWith(".webm"));
        expect(videoFiles).toHaveLength(2);
        expect((await stat(pageVideoPath)).size).toBeGreaterThan(0);
        expect((await stat(popupVideoPath)).size).toBeGreaterThan(0);
      } finally {
        await context.close();
      }
    } finally {
      await browser.close();
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
