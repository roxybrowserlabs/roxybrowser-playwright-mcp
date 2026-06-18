import type { Locator } from "./types/api.js";
import type { Rect, ScreenshotOptions } from "./types/options.js";

declare global {
  interface Window {
    __pwCleanupScreenshot?: () => void;
  }
}

export interface ScreenshotEvaluationTarget {
  evaluate<R, Arg>(pageFunction: ((arg: Arg) => R | Promise<R>) | string, arg: Arg): Promise<R>;
}

export interface ScreenshotPageTarget {
  frames(): ScreenshotEvaluationTarget[];
}

type ScreenshotPreparationOptions = Pick<ScreenshotOptions, "animations" | "caret" | "style">;
type ScreenshotMaskOptions = Pick<ScreenshotOptions, "mask" | "maskColor">;

type ScreenshotPreparationPayload = {
  disableAnimations: boolean;
  hideCaret: boolean;
  prepareSource: string;
  screenshotStyle: string;
  syncAnimations: boolean;
};

export async function preparePageForScreenshot(
  page: ScreenshotPageTarget,
  options: ScreenshotPreparationOptions & ScreenshotMaskOptions
): Promise<() => Promise<void>> {
  const payload = createScreenshotPreparationPayload(options);
  const frames = page.frames();
  await Promise.all(frames.map((frame) => prepareFrameForScreenshot(frame, payload)));
  const cleanupMasks = await maskElements(options);
  return async () => {
    await Promise.all([
      cleanupMasks(),
      ...frames.map((frame) => restoreFrameAfterScreenshot(frame))
    ]);
  };
}

export async function prepareElementDocumentForScreenshot(
  element: { evaluate<R, Arg>(pageFunction: (element: unknown, arg: Arg) => R | Promise<R>, arg: Arg): Promise<R> },
  options: ScreenshotPreparationOptions
): Promise<() => Promise<void>> {
  const payload = createScreenshotPreparationPayload(options);
  await element.evaluate(
    (_element, payload) => {
      const prepare = globalThis.eval(`(${payload.prepareSource})`) as typeof inPagePrepareForScreenshots;
      prepare(payload.screenshotStyle, payload.hideCaret, payload.disableAnimations, payload.syncAnimations);
    },
    payload
  );
  return async () => {
    await element.evaluate(
      () => {
        window.__pwCleanupScreenshot && window.__pwCleanupScreenshot();
      },
      undefined
    ).catch(() => {});
  };
}

async function maskElements(options: ScreenshotMaskOptions): Promise<() => Promise<void>> {
  if (!options.mask?.length) {
    return async () => {};
  }

  const cleanups: Array<() => Promise<void>> = [];
  try {
    for (const locator of options.mask) {
      const handle = await locator.elementHandle({ timeout: 0 }).catch(() => null);
      const box = await handle?.boundingBox().catch(() => null);
      if (!handle || !box) {
        continue;
      }
      await maskElement(handle, box, options.maskColor ?? "#F0F");
      cleanups.push(async () => {
        await handle.evaluate(() => {
          document.querySelectorAll("[data-roxy-screenshot-mask]").forEach((node) => node.remove());
        }).catch(() => {});
      });
    }
    return async () => {
      await Promise.all(cleanups.map((cleanup) => cleanup()));
    };
  } catch (error) {
    await Promise.all(cleanups.map((cleanup) => cleanup().catch(() => {})));
    throw error;
  }
}

async function maskElement(handle: LocatorMaskHandle, box: Rect, color: string): Promise<void> {
  await handle.evaluate(
    (_element, payload) => {
      const overlay = document.createElement("div");
      overlay.setAttribute("data-roxy-screenshot-mask", "true");
      Object.assign(overlay.style, {
        position: "fixed",
        left: `${payload.box.x}px`,
        top: `${payload.box.y}px`,
        width: `${payload.box.width}px`,
        height: `${payload.box.height}px`,
        background: payload.color,
        pointerEvents: "none",
        zIndex: "2147483647"
      });
      document.documentElement.append(overlay);
    },
    { box, color }
  );
}

type LocatorMaskHandle = Awaited<ReturnType<Locator["elementHandle"]>> & {
  boundingBox(): Promise<Rect | null>;
};

async function prepareFrameForScreenshot(
  frame: ScreenshotEvaluationTarget,
  payload: ScreenshotPreparationPayload
): Promise<void> {
  await frame.evaluate(
    (framePayload) => {
      const prepare = globalThis.eval(`(${framePayload.prepareSource})`) as typeof inPagePrepareForScreenshots;
      prepare(
        framePayload.screenshotStyle,
        framePayload.hideCaret,
        framePayload.disableAnimations,
        framePayload.syncAnimations
      );
    },
    payload
  ).catch(() => {});
}

async function restoreFrameAfterScreenshot(frame: ScreenshotEvaluationTarget): Promise<void> {
  await frame.evaluate(
    () => {
      window.__pwCleanupScreenshot && window.__pwCleanupScreenshot();
    },
    undefined
  ).catch(() => {});
}

function createScreenshotPreparationPayload(options: ScreenshotPreparationOptions): ScreenshotPreparationPayload {
  return {
    disableAnimations: options.animations === "disabled",
    hideCaret: options.caret !== "initial",
    prepareSource: inPagePrepareForScreenshots.toString(),
    screenshotStyle: options.style ?? "",
    syncAnimations: false
  };
}

function inPagePrepareForScreenshots(
  screenshotStyle: string,
  hideCaret: boolean,
  disableAnimations: boolean,
  syncAnimations: boolean
) {
  if (syncAnimations) {
    const style = document.createElement("style");
    style.textContent = "body {}";
    document.head.appendChild(style);
    document.documentElement.getBoundingClientRect();
    style.remove();
  }

  if (!screenshotStyle && !hideCaret && !disableAnimations) {
    return;
  }

  const collectRoots = (root: Document | ShadowRoot, roots: Array<Document | ShadowRoot> = []): Array<Document | ShadowRoot> => {
    roots.push(root);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    do {
      const node = walker.currentNode;
      const shadowRoot = node instanceof Element ? node.shadowRoot : null;
      if (shadowRoot) {
        collectRoots(shadowRoot, roots);
      }
    } while (walker.nextNode());
    return roots;
  };

  const roots = collectRoots(document);
  const cleanupCallbacks: Array<() => void> = [];

  if (screenshotStyle) {
    for (const root of roots) {
      const styleTag = document.createElement("style");
      styleTag.textContent = screenshotStyle;
      if (root === document) {
        document.documentElement.append(styleTag);
      } else {
        root.append(styleTag);
      }

      cleanupCallbacks.push(() => {
        styleTag.remove();
      });
    }
  }

  if (hideCaret) {
    const elements = new Map<HTMLElement, { priority: string; value: string }>();
    for (const root of roots) {
      root.querySelectorAll("input,textarea,[contenteditable]").forEach((element) => {
        elements.set(element as HTMLElement, {
          value: (element as HTMLElement).style.getPropertyValue("caret-color"),
          priority: (element as HTMLElement).style.getPropertyPriority("caret-color")
        });
        (element as HTMLElement).style.setProperty("caret-color", "transparent", "important");
      });
    }
    cleanupCallbacks.push(() => {
      for (const [element, value] of elements) {
        element.style.setProperty("caret-color", value.value, value.priority);
      }
    });
  }

  if (disableAnimations) {
    const infiniteAnimationsToResume: Set<Animation> = new Set();
    const handleAnimations = (root: Document | ShadowRoot): void => {
      for (const animation of root.getAnimations()) {
        if (!animation.effect || animation.playbackRate === 0 || infiniteAnimationsToResume.has(animation)) {
          continue;
        }
        const endTime = animation.effect.getComputedTiming().endTime;
        if (Number.isFinite(endTime)) {
          try {
            animation.finish();
          } catch {
          }
        } else {
          try {
            animation.cancel();
            infiniteAnimationsToResume.add(animation);
          } catch {
          }
        }
      }
    };
    for (const root of roots) {
      const handleRootAnimations: () => void = handleAnimations.bind(null, root);
      handleRootAnimations();
      root.addEventListener("transitionrun", handleRootAnimations);
      root.addEventListener("animationstart", handleRootAnimations);
      cleanupCallbacks.push(() => {
        root.removeEventListener("transitionrun", handleRootAnimations);
        root.removeEventListener("animationstart", handleRootAnimations);
      });
    }
    cleanupCallbacks.push(() => {
      for (const animation of infiniteAnimationsToResume) {
        try {
          animation.play();
        } catch {
        }
      }
    });
  }

  window.__pwCleanupScreenshot = () => {
    for (const cleanupCallback of cleanupCallbacks) {
      cleanupCallback();
    }
    delete window.__pwCleanupScreenshot;
  };
}
