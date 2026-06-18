import { describe, expect, it } from "vitest";
import { withPage } from "../../helpers/browser.js";

describe("page screencast frame contract e2e", () => {
  it("throws when start is called while a screencast is already active", async () => {
    await withPage(async (page) => {
      const recording = await page.screencast.start({
        onFrame: () => {}
      });

      await expect(
        page.screencast.start({
          onFrame: () => {}
        })
      ).rejects.toThrow("Screencast is already started");

      await recording.dispose();
    });
  });

  it("streams jpeg frames scaled to the requested maximum size", async () => {
    await withPage(async (page) => {
      await page.setViewportSize({ width: 1000, height: 400 });
      const frames: Buffer[] = [];

      const recording = await page.screencast.start({
        onFrame: (frame) => {
          frames.push(frame.data);
        },
        size: {
          width: 320,
          height: 400
        },
        quality: 60
      });
      await page.goto("data:text/html,<body></body>");
      await waitFor(() => frames.length > 0);
      frames.length = 0;
      await page.evaluate(`() => {
        document.body.style.backgroundColor = "red";
      }`);

      await waitFor(() => frames.length > 0);
      await recording.dispose();

      expect(frames.length).toBeGreaterThan(0);
      for (const frame of frames) {
        expect(frame[0]).toBe(0xff);
        expect(frame[1]).toBe(0xd8);
        expect(jpegDimensions(frame)).toEqual({
          width: 320,
          height: 128
        });
      }
    });
  });

  it("includes viewport size and timestamp in onFrame metadata", async () => {
    await withPage(async (page) => {
      await page.setViewportSize({ width: 1000, height: 400 });
      const frames: Array<{
        timestamp: number;
        viewportWidth: number;
        viewportHeight: number;
      }> = [];

      const recording = await page.screencast.start({
        onFrame: ({ timestamp, viewportWidth, viewportHeight }) => {
          frames.push({ timestamp, viewportWidth, viewportHeight });
        },
        size: {
          width: 500,
          height: 400
        }
      });
      await page.goto("data:text/html,<body></body>");
      await waitFor(() => frames.length > 0);
      frames.length = 0;
      await page.evaluate(`() => {
        document.body.style.backgroundColor = "red";
      }`);

      await waitFor(() => frames.length > 0);
      await recording.dispose();

      expect(frames.length).toBeGreaterThan(0);
      for (const frame of frames) {
        expect(frame.viewportWidth).toBe(1000);
        expect(frame.viewportHeight).toBe(400);
        expect(frame.timestamp).toBeGreaterThan(0);
      }
    });
  });

  it("can restart after stop with different size options", async () => {
    await withPage(async (page) => {
      await page.setViewportSize({ width: 1000, height: 400 });

      const firstRunFrames: Buffer[] = [];
      const firstRecording = await page.screencast.start({
        onFrame: ({ data }) => {
          firstRunFrames.push(data);
        },
        size: {
          width: 500,
          height: 400
        }
      });
      await page.goto("data:text/html,<body></body>");
      await waitFor(() => firstRunFrames.length > 0);
      firstRunFrames.length = 0;
      await page.evaluate(`() => {
        document.body.style.backgroundColor = "red";
      }`);
      await waitFor(() => firstRunFrames.length > 0);
      await firstRecording.dispose();

      const secondRunFrames: Buffer[] = [];
      const secondRecording = await page.screencast.start({
        onFrame: ({ data }) => {
          secondRunFrames.push(data);
        },
        size: {
          width: 320,
          height: 240
        }
      });
      await waitFor(() => secondRunFrames.length > 0);
      secondRunFrames.length = 0;
      await page.evaluate(`() => {
        document.body.style.backgroundColor = "blue";
      }`);
      await waitFor(() => secondRunFrames.length > 0);
      await secondRecording.dispose();

      expect(jpegDimensions(firstRunFrames[0]!)).toEqual({
        width: 500,
        height: 200
      });
      expect(jpegDimensions(secondRunFrames[0]!)).toEqual({
        width: 320,
        height: 128
      });
    });
  });

  it("disposable stop prevents later page changes from producing more frames", async () => {
    await withPage(async (page) => {
      await page.setViewportSize({ width: 1000, height: 400 });
      const frames: Buffer[] = [];

      const recording = await page.screencast.start({
        onFrame: ({ data }) => {
          frames.push(data);
        },
        size: {
          width: 500,
          height: 400
        }
      });
      await page.goto("data:text/html,<body></body>");
      await waitFor(() => frames.length > 0);
      frames.length = 0;

      await page.evaluate(`() => {
        document.body.style.backgroundColor = "red";
      }`);
      await waitFor(() => frames.length > 0);
      const frameCountBeforeDispose = frames.length;

      await recording.dispose();

      await page.evaluate(`() => {
        document.body.style.backgroundColor = "blue";
      }`);
      await new Promise((resolve) => setTimeout(resolve, 500));

      expect(frames.length).toBe(frameCountBeforeDispose);
    });
  });

  it("treats stop as a no-op when no screencast is active", async () => {
    await withPage(async (page) => {
      await expect(page.screencast.stop()).resolves.toBeUndefined();
    });
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for screencast frames");
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function jpegDimensions(buffer: Buffer): { width: number; height: number } {
  let index = 2;
  while (index < buffer.length - 8) {
    if (buffer[index] !== 0xff) {
      break;
    }
    const marker = buffer[index + 1];
    const segmentLength = buffer.readUInt16BE(index + 2);
    if (
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    ) {
      return {
        height: buffer.readUInt16BE(index + 5),
        width: buffer.readUInt16BE(index + 7)
      };
    }
    index += 2 + segmentLength;
  }
  throw new Error("Could not parse JPEG dimensions");
}
