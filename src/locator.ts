import { readFile, stat } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { TimeoutError } from "./errors.js";
import { assertFillValue } from "./assertions.js";
import type { HumanController } from "./human/types.js";
import { resolveHumanizationOptions } from "./human/profile.js";
import type { ResolvedHumanizationOptions } from "./human/types.js";
import { assertMaxArguments, serializePageFunction } from "./evaluation.js";
import { RoxyElementHandle, serializeEvaluationArgument, type ElementHandleFrameResolver } from "./elementHandle.js";
import { convertInputFiles, type InputFiles } from "./inputFiles.js";
import { normalizeSelectOptionValues } from "./selectOptionValues.js";
import { createRemoteJSHandle, createSmartHandle } from "./jsHandle.js";
import {
  createAltTextLocatorSelector,
  createInternalTextLocatorSelector,
  createLabelLocatorSelector,
  createPlaceholderLocatorSelector,
  createRoleLocatorSelector,
  createTestIdLocatorSelector,
  createTextLocatorSelector,
  createTitleLocatorSelector
} from "./locatorSelectors.js";
import type { LocatorSelector, ProtocolLocatorAdapter } from "./protocol/adapter.js";
import { parseSelectorChain } from "./selectors.js";
import type {
  Disposable,
  ElementHandle,
  FrameLocator,
  Locator,
  Page,
  PageFunctionOn,
  SmartHandle
} from "./types/api.js";
import type {
  AriaSnapshotOptions,
  ClickOptions,
  DispatchEventOptions,
  FillOptions,
  GetByAltTextOptions,
  GetByLabelOptions,
  GetByPlaceholderOptions,
  GetByRoleOptions,
  GetByTextOptions,
  GetByTitleOptions,
  HoverOptions,
  PressOptions,
  Rect,
  ScreenshotOptions,
  SelectTextOptions,
  SelectOptionValue,
  SetInputFilesOptions,
  TapOptions,
  TimeoutOptions,
  TypeOptions
} from "./types/options.js";

const ENTER_FRAME_SELECTOR: LocatorSelector = {
  strategy: "control",
  value: "enter-frame"
};
const DEFAULT_LOCATOR_HUMAN_DEFAULTS = resolveHumanizationOptions({ enabled: false });
const DEFAULT_WAIT_TIMEOUT_MS = 30_000;

type ActionOptionsLike = { force?: boolean; timeout?: number } | undefined;
type PointerActionOptions = (ClickOptions | HoverOptions) | undefined;
type LocatorOptions = {
  has?: Locator;
  hasNot?: Locator;
  hasNotText?: string | RegExp;
  hasText?: string | RegExp;
};
type LocatorFilterOptions = LocatorOptions & {
  visible?: boolean;
};
type LocatorClearOptions = { force?: boolean; noWaitAfter?: boolean; timeout?: number };
type LocatorDragToOptions = {
  force?: boolean;
  noWaitAfter?: boolean;
  sourcePosition?: { x: number; y: number };
  steps?: number;
  targetPosition?: { x: number; y: number };
  timeout?: number;
  trial?: boolean;
};
type LocatorDropPayload = {
  files?: string | Array<string> | { name: string; mimeType: string; buffer: Buffer } | Array<{ name: string; mimeType: string; buffer: Buffer }>;
  data?: { [key: string]: string };
};
type LocatorDropOptions = { position?: { x: number; y: number }; timeout?: number };
type LocatorPressSequentiallyOptions = { delay?: number; noWaitAfter?: boolean; timeout?: number };
type LocatorDropFilePayload = {
  buffer: string;
  lastModifiedMs?: number;
  mimeType: string;
  name: string;
};
type LocatorActionPointOptions = {
  position?: { x: number; y: number };
  timeout?: number;
};

function cloneLocatorSelector(selector: LocatorSelector): LocatorSelector {
  return {
    ...selector,
    ...(selector.hasChain ? { hasChain: selector.hasChain.map(cloneLocatorSelector) } : {})
  };
}

function cloneLocatorSelectorChain(chain: LocatorSelector[]): LocatorSelector[] {
  return chain.map(cloneLocatorSelector);
}

function selectorChainForLocator(locator: Locator, optionName: "has" | "hasNot"): LocatorSelector[] {
  const chain = locator._roxySelectorChain?.();
  if (!chain) {
    throw new Error(`Inner "${optionName}" locator must belong to the same frame.`);
  }
  return cloneLocatorSelectorChain(chain);
}

function frameIdentityForLocator(locator: Locator): string | undefined {
  return locator._roxyFrameIdentity?.();
}

function assertSameFrameLocator(
  currentFrameIdentity: string | undefined,
  locator: Locator,
  errorMessage: string
): void {
  const innerFrameIdentity = frameIdentityForLocator(locator);
  if (
    currentFrameIdentity !== undefined &&
    innerFrameIdentity !== undefined &&
    currentFrameIdentity !== innerFrameIdentity
  ) {
    throw new Error(errorMessage);
  }
}

function selectorChainForSameFrameLocator(
  currentFrameIdentity: string | undefined,
  locator: Locator,
  errorMessage: string
): LocatorSelector[] {
  assertSameFrameLocator(currentFrameIdentity, locator, errorMessage);
  const chain = locator._roxySelectorChain?.();
  if (!chain) {
    throw new Error(errorMessage);
  }
  return cloneLocatorSelectorChain(chain);
}

class DisposableStub implements Disposable {
  constructor(private readonly callback: () => Promise<void> | void) {}

  dispose(): Promise<void> | void {
    return this.callback();
  }
}

async function convertDropFiles(files: LocatorDropPayload["files"]): Promise<LocatorDropFilePayload[]> {
  if (files === undefined) {
    return [];
  }
  const items = Array.isArray(files) ? files : [files];
  if (items.every((item) => typeof item === "string")) {
    return Promise.all(items.map(async (filePath) => {
      const resolved = resolve(filePath);
      const [buffer, fileStat] = await Promise.all([
        readFile(resolved),
        stat(resolved)
      ]);
      return {
        buffer: buffer.toString("base64"),
        lastModifiedMs: fileStat.mtimeMs,
        mimeType: inferDropMimeType(resolved),
        name: basename(resolved)
      };
    }));
  }
  const resolved = await convertInputFiles(items as InputFiles);
  return resolved.payloads.map((payload) => ({
    buffer: payload.base64,
    mimeType: payload.mimeType,
    name: payload.name,
    ...(payload.lastModifiedMs === undefined ? {} : { lastModifiedMs: payload.lastModifiedMs })
  }));
}

function inferDropMimeType(filePath: string): string {
  const extension = extname(filePath).toLowerCase();
  switch (extension) {
    case ".avif":
      return "image/avif";
    case ".bmp":
      return "image/bmp";
    case ".css":
      return "text/css";
    case ".csv":
      return "text/csv";
    case ".gif":
      return "image/gif";
    case ".htm":
    case ".html":
      return "text/html";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".js":
    case ".mjs":
      return "text/javascript";
    case ".json":
      return "application/json";
    case ".md":
      return "text/markdown";
    case ".pdf":
      return "application/pdf";
    case ".png":
      return "image/png";
    case ".svg":
      return "image/svg+xml";
    case ".txt":
      return "text/plain";
    case ".webp":
      return "image/webp";
    case ".xml":
      return "application/xml";
    case ".zip":
      return "application/zip";
    default:
      return "application/octet-stream";
  }
}

function chainLocator(
  adapter: ProtocolLocatorAdapter,
  selector: string
): ProtocolLocatorAdapter {
  const chain = parseSelectorChain(selector);
  const [first, ...rest] = chain;
  if (!first) {
    throw new Error("Selector must not be empty.");
  }

  let current = adapter.locator(first);
  for (const part of rest) {
    current = current.locator(part);
  }
  return current;
}

export class RoxyLocator implements Locator {
  private readonly selectorChain: LocatorSelector[] | null;

  constructor(
    private readonly adapter: ProtocolLocatorAdapter,
    private readonly humanController: HumanController,
    selectorChain: LocatorSelector[] | null = null,
    private readonly beforeAction?: (locator: RoxyLocator, options?: ActionOptionsLike) => Promise<boolean | void>,
    private readonly humanDefaults: ResolvedHumanizationOptions = DEFAULT_LOCATOR_HUMAN_DEFAULTS,
    private readonly frameResolver?: ElementHandleFrameResolver,
    private readonly ownerPage?: Page,
    private readonly frameIdentity?: string
  ) {
    this.selectorChain = selectorChain ? cloneLocatorSelectorChain(selectorChain) : null;
  }

  _roxySelectorChain(): LocatorSelector[] | null {
    return this.selectorChain ? cloneLocatorSelectorChain(this.selectorChain) : null;
  }

  _roxyFrameIdentity(): string | undefined {
    return this.frameIdentity;
  }

  page(): Page {
    if (!this.ownerPage) {
      throw new Error("Locator is not associated with a page.");
    }
    return this.ownerPage;
  }

  private cloneWith(
    adapter: ProtocolLocatorAdapter,
    selectorChain: LocatorSelector[] | null = this.selectorChain
  ): RoxyLocator {
    return new RoxyLocator(
      adapter,
      this.humanController,
      selectorChain,
      this.beforeAction,
      this.humanDefaults,
      this.frameResolver,
      this.ownerPage,
      this.frameIdentity
    );
  }

  locator(selectorOrLocator: string | Locator, options?: LocatorOptions): Locator {
    if (typeof selectorOrLocator !== "string") {
      const selector: LocatorSelector = {
        strategy: "control",
        value: "chain",
        composite: "chain",
        hasChain: selectorChainForSameFrameLocator(
          this.frameIdentity,
          selectorOrLocator,
          "Locators must belong to the same frame."
        )
      };
      const locator = this.cloneWith(
        this.adapter.locator(selector),
        [...(this.selectorChain ?? []), selector]
      );
      return options ? locator.filter(options) : locator;
    }
    const selector = selectorOrLocator;
    const chain = parseSelectorChain(selector);
    const locator = new RoxyLocator(
      chainLocator(this.adapter, selector),
      this.humanController,
      [...(this.selectorChain ?? []), ...chain],
      this.beforeAction,
      this.humanDefaults,
      this.frameResolver,
      this.ownerPage,
      this.frameIdentity
    );
    return options ? locator.filter(options) : locator;
  }

  _roxyLocatorFromChain(chain: LocatorSelector[], options?: LocatorFilterOptions): Locator {
    let adapter = this.adapter;
    for (const selector of chain) {
      adapter = adapter.locator(selector);
    }
    const locator = this.cloneWith(
      adapter,
      [...(this.selectorChain ?? []), ...cloneLocatorSelectorChain(chain)]
    );
    return options ? locator.filter(options) : locator;
  }

  frameLocator(selector: string): FrameLocator {
    return this.locator(selector).contentFrame();
  }

  contentFrame(): FrameLocator {
    return new RoxyFrameLocator(
      this,
      new RoxyLocator(
        this.adapter.locator(ENTER_FRAME_SELECTOR),
        this.humanController,
        [...(this.selectorChain ?? []), ENTER_FRAME_SELECTOR],
        this.beforeAction,
        this.humanDefaults,
        this.frameResolver,
        this.ownerPage,
        this.frameIdentity
      )
    );
  }

  getByText(text: string | RegExp, options?: GetByTextOptions): Locator {
    return new RoxyLocator(
      this.adapter.getByText(text, options),
      this.humanController,
      this.extendSelectorChain("getByText", text, options),
      this.beforeAction,
      this.humanDefaults,
      this.frameResolver,
      this.ownerPage,
      this.frameIdentity
    );
  }

  getByAltText(text: string | RegExp, options?: GetByAltTextOptions): Locator {
    return new RoxyLocator(
      this.adapter.getByAltText(text, options),
      this.humanController,
      this.extendSelectorChain("getByAltText", text, options),
      this.beforeAction,
      this.humanDefaults,
      this.frameResolver,
      this.ownerPage,
      this.frameIdentity
    );
  }

  getByLabel(text: string | RegExp, options?: GetByLabelOptions): Locator {
    return new RoxyLocator(
      this.adapter.getByLabel(text, options),
      this.humanController,
      this.extendSelectorChain("getByLabel", text, options),
      this.beforeAction,
      this.humanDefaults,
      this.frameResolver,
      this.ownerPage,
      this.frameIdentity
    );
  }

  getByPlaceholder(text: string | RegExp, options?: GetByPlaceholderOptions): Locator {
    return new RoxyLocator(
      this.adapter.getByPlaceholder(text, options),
      this.humanController,
      this.extendSelectorChain("getByPlaceholder", text, options),
      this.beforeAction,
      this.humanDefaults,
      this.frameResolver,
      this.ownerPage,
      this.frameIdentity
    );
  }

  getByTestId(testId: string | RegExp): Locator {
    return new RoxyLocator(
      this.adapter.getByTestId(testId),
      this.humanController,
      this.extendSelectorChain("getByTestId", testId),
      this.beforeAction,
      this.humanDefaults,
      this.frameResolver,
      this.ownerPage,
      this.frameIdentity
    );
  }

  getByRole(role: string, options?: GetByRoleOptions): Locator {
    return new RoxyLocator(
      this.adapter.getByRole(role, options),
      this.humanController,
      this.extendSelectorChain("getByRole", role, options),
      this.beforeAction,
      this.humanDefaults,
      this.frameResolver,
      this.ownerPage,
      this.frameIdentity
    );
  }

  getByTitle(text: string | RegExp, options?: GetByTitleOptions): Locator {
    return new RoxyLocator(
      this.adapter.getByTitle(text, options),
      this.humanController,
      this.extendSelectorChain("getByTitle", text, options),
      this.beforeAction,
      this.humanDefaults,
      this.frameResolver,
      this.ownerPage,
      this.frameIdentity
    );
  }

  first(): Locator {
    return this.cloneWith(this.adapter.first());
  }

  last(): Locator {
    return this.cloneWith(this.adapter.last());
  }

  nth(index: number): Locator {
    return this.cloneWith(this.adapter.nth(index));
  }

  filter(options?: LocatorFilterOptions): Locator {
    let adapter = this.adapter;
    const chain = [...(this.selectorChain ?? [])];
    if (options?.has !== undefined) {
      const selector: LocatorSelector = {
        strategy: "control",
        value: "has",
        filter: true,
        hasChain: selectorChainForSameFrameLocator(
          this.frameIdentity,
          options.has,
          'Inner "has" locator must belong to the same frame.'
        )
      };
      adapter = adapter.locator(selector);
      chain.push(selector);
    }
    if (options?.hasNot !== undefined) {
      const selector: LocatorSelector = {
        strategy: "control",
        value: "has-not",
        filter: true,
        negate: true,
        hasChain: selectorChainForSameFrameLocator(
          this.frameIdentity,
          options.hasNot,
          'Inner "hasNot" locator must belong to the same frame.'
        )
      };
      adapter = adapter.locator(selector);
      chain.push(selector);
    }
    if (options?.hasText !== undefined) {
      const selector: LocatorSelector = {
        ...createInternalTextLocatorSelector(options.hasText),
        filter: true
      };
      adapter = adapter.locator(selector);
      chain.push(selector);
    }
    if (options?.hasNotText !== undefined) {
      const selector: LocatorSelector = {
        ...createInternalTextLocatorSelector(options.hasNotText),
        filter: true,
        negate: true
      };
      adapter = adapter.locator(selector);
      chain.push(selector);
    }
    if (options?.visible !== undefined) {
      const selector: LocatorSelector = {
        strategy: "control",
        value: "visible",
        filter: true,
        visible: options.visible
      };
      adapter = adapter.locator(selector);
      chain.push(selector);
    }
    return this.cloneWith(adapter, chain);
  }

  and(locator: Locator): Locator {
    const selector: LocatorSelector = {
      strategy: "control",
      value: "and",
      composite: "and",
      hasChain: selectorChainForSameFrameLocator(
        this.frameIdentity,
        locator,
        "Locators must belong to the same frame."
      )
    };
    return this.cloneWith(
      this.adapter.locator(selector),
      [...(this.selectorChain ?? []), selector]
    );
  }

  or(locator: Locator): Locator {
    const selector: LocatorSelector = {
      strategy: "control",
      value: "or",
      composite: "or",
      hasChain: selectorChainForSameFrameLocator(
        this.frameIdentity,
        locator,
        "Locators must belong to the same frame."
      )
    };
    return this.cloneWith(
      this.adapter.locator(selector),
      [...(this.selectorChain ?? []), selector]
    );
  }

  describe(description: string): Locator {
    return this.cloneWith(this.adapter, [
      ...(this.selectorChain ?? []),
      { strategy: "control", value: "describe", description }
    ]);
  }

  description(): null | string {
    const lastSelector = this.selectorChain?.[this.selectorChain.length - 1];
    return lastSelector?.strategy === "control" && lastSelector.value === "describe"
      ? lastSelector.description ?? null
      : null;
  }

  async all(): Promise<Array<Locator>> {
    return Array.from({ length: await this.count() }, (_value, index) => this.nth(index));
  }

  async allInnerTexts(): Promise<Array<string>> {
    return this.evaluateAll((elements) => elements.map((element) => (element as HTMLElement).innerText));
  }

  async allTextContents(): Promise<Array<string>> {
    return this.evaluateAll((elements) => elements.map((element) => element.textContent || ""));
  }

  async count(): Promise<number> {
    return this.adapter.count();
  }

  async evaluate<R, Arg>(
    pageFunction: PageFunctionOn<SVGElement | HTMLElement, Arg, R>,
    arg: Arg,
    options?: TimeoutOptions
  ): Promise<R>;
  async evaluate<R>(
    pageFunction: PageFunctionOn<SVGElement | HTMLElement, void, R>,
    options?: TimeoutOptions
  ): Promise<R>;
  async evaluate<R, Arg>(
    pageFunction: PageFunctionOn<SVGElement | HTMLElement, Arg, R>,
    argOrOptions?: Arg | TimeoutOptions,
    options?: TimeoutOptions
  ): Promise<R> {
    assertMaxArguments(arguments.length, 3);
    const hasArg = arguments.length >= 2 && (arguments.length !== 2 || !looksLikeTimeoutOptions(argOrOptions));
    void (hasArg ? options : argOrOptions);
    return this.adapter.evaluate<R>(
      serializePageFunction(pageFunction as string | ((element: unknown, arg: Arg) => R | Promise<R>)),
      serializeEvaluationArgument(hasArg ? argOrOptions : undefined),
      typeof pageFunction === "function"
    );
  }

  async evaluateAll<R, Arg, E extends SVGElement | HTMLElement = SVGElement | HTMLElement>(
    pageFunction: PageFunctionOn<E[], Arg, R>,
    arg: Arg
  ): Promise<R>;
  async evaluateAll<R, E extends SVGElement | HTMLElement = SVGElement | HTMLElement>(
    pageFunction: PageFunctionOn<E[], void, R>
  ): Promise<R>;
  async evaluateAll<R, Arg, E extends SVGElement | HTMLElement = SVGElement | HTMLElement>(
    pageFunction: PageFunctionOn<E[], Arg, R>,
    arg?: Arg
  ): Promise<R> {
    assertMaxArguments(arguments.length, 2);
    return this.adapter.evaluateAll<R>(
      serializePageFunction(pageFunction as string | ((elements: unknown[], arg: Arg) => R | Promise<R>)),
      serializeEvaluationArgument(arg),
      typeof pageFunction === "function"
    );
  }

  async evaluateHandle<R, Arg>(
    pageFunction: PageFunctionOn<SVGElement | HTMLElement, Arg, R>,
    arg: Arg,
    options?: TimeoutOptions
  ): Promise<SmartHandle<R>>;
  async evaluateHandle<R>(
    pageFunction: PageFunctionOn<SVGElement | HTMLElement, void, R>,
    options?: TimeoutOptions
  ): Promise<SmartHandle<R>>;
  async evaluateHandle<R, Arg>(
    pageFunction: PageFunctionOn<SVGElement | HTMLElement, Arg, R>,
    argOrOptions?: Arg | TimeoutOptions,
    options?: TimeoutOptions
  ): Promise<SmartHandle<R>> {
    assertMaxArguments(arguments.length, 3);
    const hasArg = arguments.length >= 2 && (arguments.length !== 2 || !looksLikeTimeoutOptions(argOrOptions));
    void (hasArg ? options : argOrOptions);
    if (this.adapter.evaluateHandle) {
      return await createRemoteJSHandle(
        await this.adapter.evaluateHandle<R>(
          serializePageFunction(pageFunction as string | ((element: unknown, arg: Arg) => R | Promise<R>)),
          serializeEvaluationArgument(hasArg ? argOrOptions : undefined),
          typeof pageFunction === "function"
        ),
        (reference) => this.frameResolver?.createElementHandleFromReference(reference)
          ?? new RoxyElementHandle(this.adapter.elementHandle() as never, this.humanDefaults, this.frameResolver)
      ) as unknown as SmartHandle<R>;
    }
    return createSmartHandle(await this.evaluate(pageFunction as PageFunctionOn<SVGElement | HTMLElement, Arg, R>, hasArg ? argOrOptions as Arg : undefined as Arg));
  }

  async boundingBox(options?: TimeoutOptions): Promise<Rect | null> {
    void options;
    return this.adapter.boundingBox();
  }

  private async actionPoint(options: LocatorActionPointOptions = {}): Promise<{ x: number; y: number }> {
    const box = await this.boundingBox(options.timeout === undefined ? undefined : { timeout: options.timeout });
    if (!box) {
      throw new Error("locator.dragTo: Element is not visible.");
    }
    const position = options.position ?? {
      x: box.width / 2,
      y: box.height / 2
    };
    return {
      x: box.x + position.x,
      y: box.y + position.y
    };
  }

  async dblclick(options?: ClickOptions): Promise<void> {
    const actionOptions = this.withBeforeActionRetry(options);
    await this.beforeAction?.(this, actionOptions);
    await this.adapter.dblclick(actionOptions);
  }

  async check(options?: ClickOptions): Promise<void> {
    const actionOptions = this.withBeforeActionRetry(options);
    await this.beforeAction?.(this, actionOptions);
    await this.adapter.check(actionOptions);
  }

  async clear(options?: LocatorClearOptions): Promise<void> {
    await this.fill("", options);
  }

  async click(options?: ClickOptions): Promise<void> {
    const actionOptions = this.withBeforeActionRetry(options);
    await this.beforeAction?.(this, actionOptions);
    await this.humanController.click(this.adapter, actionOptions);
  }

  async hover(options?: HoverOptions): Promise<void> {
    const actionOptions = this.withBeforeActionRetry(options);
    await this.beforeAction?.(this, actionOptions);
    await this.humanController.hover(this.adapter, actionOptions);
  }

  async fill(value: string, options?: FillOptions): Promise<void> {
    assertFillValue(value);
    await this.beforeAction?.(this, options);
    await this.humanController.fill(this.adapter, value, options);
  }

  async type(value: string, options?: TypeOptions): Promise<void> {
    await this.beforeAction?.(this, options);
    await this.humanController.type(this.adapter, value, options);
  }

  async press(key: string, options?: PressOptions): Promise<void> {
    await this.beforeAction?.(this, options);
    await this.humanController.press(this.adapter, key, options);
  }

  async pressSequentially(text: string, options?: LocatorPressSequentiallyOptions): Promise<void> {
    await this.type(text, options);
  }

  async focus(): Promise<void> {
    await this.adapter.focus();
  }

  async blur(options?: { timeout?: number }): Promise<void> {
    void options;
    await this.adapter.blur();
  }

  async dispatchEvent(
    type: string,
    eventInit?: unknown,
    options?: DispatchEventOptions
  ): Promise<void> {
    await this.adapter.dispatchEvent(type, eventInit, options);
  }

  async dragTo(target: Locator, options?: LocatorDragToOptions): Promise<void> {
    const sourcePoint = await this.actionPoint({
      ...(options?.sourcePosition === undefined ? {} : { position: options.sourcePosition }),
      ...(options?.timeout === undefined ? {} : { timeout: options.timeout })
    });
    if (!(target instanceof RoxyLocator)) {
      throw new Error("locator.dragTo: Target must be a Roxy locator.");
    }
    const targetPoint = await target.actionPoint({
      ...(options?.targetPosition === undefined ? {} : { position: options.targetPosition }),
      ...(options?.timeout === undefined ? {} : { timeout: options.timeout })
    });
    if (options?.trial) {
      return;
    }
    const mouse = this.page().mouse;
    await mouse.move(sourcePoint.x, sourcePoint.y);
    await mouse.down();
    await mouse.move(
      targetPoint.x,
      targetPoint.y,
      options?.steps === undefined ? undefined : { steps: options.steps }
    );
    await mouse.up();
  }

  async drop(payload: LocatorDropPayload, options?: LocatorDropOptions): Promise<void> {
    const hasFiles = payload.files !== undefined && (Array.isArray(payload.files) ? payload.files.length > 0 : true);
    const hasData = payload.data !== undefined && Object.keys(payload.data).length > 0;
    if (!hasFiles && !hasData) {
      throw new Error('At least one of "files" or "data" must be provided.');
    }

    const handle = await this.elementHandle(options?.timeout === undefined ? {} : { timeout: options.timeout });
    if (!handle) {
      throw new Error("No element found.");
    }
    const files = hasFiles ? await convertDropFiles(payload.files) : [];
    const data = payload.data ?? {};
    const result = await handle.evaluate(
      (element, dropPayload) => {
        if (!element.isConnected) {
          return "error:notconnected" as const;
        }
        const dataTransfer = new DataTransfer();
        for (const file of dropPayload.files) {
          const bytes = Uint8Array.from(atob(file.buffer), (char) => char.charCodeAt(0));
          const fileOptions: FilePropertyBag = { type: file.mimeType || "application/octet-stream" };
          if (file.lastModifiedMs !== undefined) {
            fileOptions.lastModified = file.lastModifiedMs;
          }
          dataTransfer.items.add(new File([bytes], file.name, fileOptions));
        }
        for (const [type, value] of Object.entries(dropPayload.data)) {
          dataTransfer.setData(type, value);
        }
        const rect = element.getBoundingClientRect();
        const point = dropPayload.position ?? {
          x: rect.width / 2,
          y: rect.height / 2
        };
        const clientX = rect.left + point.x;
        const clientY = rect.top + point.y;
        const makeEvent = (type: string) => new DragEvent(type, {
          bubbles: true,
          cancelable: true,
          clientX,
          clientY,
          composed: true,
          dataTransfer
        });
        element.dispatchEvent(makeEvent("dragenter"));
        const over = makeEvent("dragover");
        element.dispatchEvent(over);
        if (!over.defaultPrevented) {
          element.dispatchEvent(makeEvent("dragleave"));
          return "not-accepted" as const;
        }
        element.dispatchEvent(makeEvent("drop"));
        return "accepted" as const;
      },
      {
        data,
        files,
        position: options?.position
      }
    );
    if (result === "error:notconnected") {
      throw new Error("Element is not attached to the DOM.");
    }
    if (result === "not-accepted") {
      throw new Error("Drop target did not accept the drop; its dragover handler did not call preventDefault().");
    }
  }

  async getAttribute(name: string): Promise<string | null> {
    return this.adapter.getAttribute(name);
  }

  async highlight(_options: { style?: string | { [key: string]: string | number } } = {}): Promise<Disposable> {
    return new DisposableStub(() => this.hideHighlight());
  }

  async hideHighlight(): Promise<void> {}

  async innerHTML(): Promise<string> {
    return this.adapter.innerHTML();
  }

  async innerText(): Promise<string> {
    return this.adapter.innerText();
  }

  async inputValue(): Promise<string> {
    return this.adapter.inputValue();
  }

  async isChecked(): Promise<boolean> {
    return this.adapter.isChecked();
  }

  async isDisabled(): Promise<boolean> {
    return this.adapter.isDisabled();
  }

  async isEditable(): Promise<boolean> {
    return this.adapter.isEditable();
  }

  async isEnabled(): Promise<boolean> {
    return this.adapter.isEnabled();
  }

  async isHidden(): Promise<boolean> {
    return this.adapter.isHidden();
  }

  async ariaSnapshot(options?: AriaSnapshotOptions): Promise<string> {
    void options;
    const handle = await this.elementHandle();
    if (!handle) {
      throw new Error("No element found.");
    }
    return handle.evaluate((element) => element.textContent ?? "");
  }

  async normalize(): Promise<Locator> {
    return this;
  }

  async textContent(): Promise<string | null> {
    return this.adapter.textContent();
  }

  async uncheck(options?: ClickOptions): Promise<void> {
    const actionOptions = this.withBeforeActionRetry(options);
    await this.beforeAction?.(this, actionOptions);
    await this.adapter.uncheck(actionOptions);
  }

  async selectOption(
    values:
      | null
      | string
      | ElementHandle
      | ReadonlyArray<string>
      | SelectOptionValue
      | ReadonlyArray<ElementHandle>
      | ReadonlyArray<SelectOptionValue>,
    options?: { force?: boolean; noWaitAfter?: boolean; timeout?: number }
  ): Promise<Array<string>> {
    await this.beforeAction?.(this, options);
    const handle = await this.elementHandle(options?.timeout === undefined ? {} : { timeout: options.timeout });
    if (!handle) {
      throw new TimeoutError(`locator.elementHandle: Timeout ${options?.timeout ?? DEFAULT_WAIT_TIMEOUT_MS}ms exceeded.`);
    }
    return this.adapter.selectOption(await normalizeSelectOptionValues(handle, values), options);
  }

  async screenshot(options?: ScreenshotOptions): Promise<Buffer> {
    const handle = await this.elementHandle(options?.timeout === undefined ? {} : { timeout: options.timeout });
    if (!handle) {
      throw new Error("No element found.");
    }
    return handle.screenshot(options);
  }

  async scrollIntoViewIfNeeded(options?: TimeoutOptions): Promise<void> {
    const handle = await this.elementHandle(options?.timeout === undefined ? {} : { timeout: options.timeout });
    if (!handle) {
      throw new Error("No element found.");
    }
    await handle.scrollIntoViewIfNeeded(options);
  }

  async selectText(options: SelectTextOptions = {}): Promise<void> {
    const handle = await this.elementHandle(options.timeout === undefined ? {} : { timeout: options.timeout });
    if (!handle) {
      throw new Error("No element found.");
    }
    await handle.selectText(options);
  }

  async setChecked(checked: boolean, options?: ClickOptions): Promise<void> {
    if (checked) {
      await this.check(options);
      return;
    }
    await this.uncheck(options);
  }

  async setInputFiles(
    files: InputFiles,
    options?: SetInputFilesOptions
  ): Promise<void> {
    const handle = await this.elementHandle(options?.timeout === undefined ? {} : { timeout: options.timeout });
    if (!handle) {
      throw new Error("No element found.");
    }
    await handle.setInputFiles(files, options);
  }

  async tap(options?: TapOptions): Promise<void> {
    await this.beforeAction?.(this, options);
    await this.adapter.tap(options);
  }

  async isVisible(): Promise<boolean> {
    return this.adapter.isVisible();
  }

  async waitFor(options: { state?: "attached" | "detached" | "hidden" | "visible"; timeout?: number } = {}): Promise<void> {
    const state = options.state ?? "visible";
    const timeout = options.timeout ?? DEFAULT_WAIT_TIMEOUT_MS;
    const startTime = Date.now();

    while (timeout === 0 || Date.now() - startTime <= timeout) {
      await this.beforeAction?.(this, {
        timeout: timeout === 0 ? 0 : Math.max(0, timeout - (Date.now() - startTime))
      });
      const count = await this.count().catch(() => 0);
      const attached = count > 0;
      const visible = attached ? await this.isVisible().catch(() => false) : false;
      if (state === "attached" && attached) return;
      if (state === "visible" && visible) return;
      if (state === "hidden" && !visible) return;
      if (state === "detached" && !attached) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    throw new TimeoutError(`Timeout ${timeout}ms exceeded.`);
  }

  async elementHandle(options: { timeout?: number } = {}): Promise<null | ElementHandle<SVGElement | HTMLElement>> {
    const timeout = options.timeout ?? DEFAULT_WAIT_TIMEOUT_MS;
    const startTime = Date.now();
    let lastError: unknown;
    while (timeout === 0 || Date.now() - startTime <= timeout) {
      try {
        return new RoxyElementHandle(await this.adapter.elementHandle(), this.humanDefaults, this.frameResolver);
      } catch (error) {
        lastError = error;
        if (timeout === 0) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    if (lastError) {
      throw lastError;
    }
    throw new TimeoutError(`Timeout ${timeout}ms exceeded.`);
  }

  async elementHandles(): Promise<Array<ElementHandle>> {
    const handles = await this.adapter.elementHandles();
    return handles.map((handle) => new RoxyElementHandle(handle, this.humanDefaults, this.frameResolver));
  }

  toString(): string {
    return this.description() ?? formatLocatorChain(this.selectorChain ?? []);
  }

  private extendSelectorChain(
    kind:
      | "getByText"
      | "getByAltText"
      | "getByLabel"
      | "getByPlaceholder"
      | "getByTestId"
      | "getByRole"
      | "getByTitle",
    value: string | RegExp,
    options?: GetByTextOptions | GetByAltTextOptions | GetByLabelOptions | GetByPlaceholderOptions | GetByRoleOptions | GetByTitleOptions
  ): LocatorSelector[] | null {
    const current = this.selectorChain ?? [];
    switch (kind) {
      case "getByText":
        return [...current, createTextLocatorSelector(value, options as GetByTextOptions | undefined)];
      case "getByAltText":
        return [...current, createAltTextLocatorSelector(value, options as GetByAltTextOptions | undefined)];
      case "getByLabel":
        return [...current, createLabelLocatorSelector(value, options as GetByLabelOptions | undefined)];
      case "getByPlaceholder":
        return [
          ...current,
          createPlaceholderLocatorSelector(value, options as GetByPlaceholderOptions | undefined)
        ];
      case "getByTestId":
        return [...current, createTestIdLocatorSelector(value)];
      case "getByRole":
        return [
          ...current,
          createRoleLocatorSelector(String(value), options as GetByRoleOptions | undefined)
        ];
      case "getByTitle":
        return [...current, createTitleLocatorSelector(value, options as GetByTitleOptions | undefined)];
    }
  }

  private withBeforeActionRetry<TOptions extends PointerActionOptions>(options: TOptions): TOptions {
    if (!this.beforeAction) {
      return options;
    }
    return {
      ...(options ?? {}),
      __roxyBeforeActionRetry: async () => {
        return await this.beforeAction?.(this, options);
      }
    } as unknown as TOptions;
  }
}

export class RoxyFrameLocator implements FrameLocator {
  constructor(
    private readonly ownerLocator: RoxyLocator,
    private readonly contentLocator: RoxyLocator
  ) {}

  first(): FrameLocator {
    return this.ownerLocator.first().contentFrame();
  }

  last(): FrameLocator {
    return this.ownerLocator.last().contentFrame();
  }

  nth(index: number): FrameLocator {
    return this.ownerLocator.nth(index).contentFrame();
  }

  frameLocator(selector: string): FrameLocator {
    return this.contentLocator.frameLocator(selector);
  }

  locator(selectorOrLocator: string | Locator, options?: LocatorFilterOptions): Locator {
    if (typeof selectorOrLocator !== "string") {
      const chain = selectorOrLocator._roxySelectorChain?.();
      if (!chain) {
        throw new Error("Locators must belong to the same frame.");
      }
      return this.contentLocator._roxyLocatorFromChain(chain, options);
    }
    const locator = this.contentLocator.locator(selectorOrLocator);
    return options ? locator.filter(options) : locator;
  }

  getByText(text: string | RegExp, options?: GetByTextOptions): Locator {
    return this.contentLocator.getByText(text, options);
  }

  getByAltText(text: string | RegExp, options?: GetByAltTextOptions): Locator {
    return this.contentLocator.getByAltText(text, options);
  }

  getByLabel(text: string | RegExp, options?: GetByLabelOptions): Locator {
    return this.contentLocator.getByLabel(text, options);
  }

  getByPlaceholder(text: string | RegExp, options?: GetByPlaceholderOptions): Locator {
    return this.contentLocator.getByPlaceholder(text, options);
  }

  getByTestId(testId: string | RegExp): Locator {
    return this.contentLocator.getByTestId(testId);
  }

  getByRole(role: string, options?: GetByRoleOptions): Locator {
    return this.contentLocator.getByRole(role, options);
  }

  getByTitle(text: string | RegExp, options?: GetByTitleOptions): Locator {
    return this.contentLocator.getByTitle(text, options);
  }

  owner(): Locator {
    return this.ownerLocator;
  }
}

function looksLikeTimeoutOptions(value: unknown): value is TimeoutOptions {
  return Boolean(
    value
      && typeof value === "object"
      && "timeout" in value
      && Object.keys(value).every((key) => key === "timeout")
  );
}

function formatLocatorChain(chain: LocatorSelector[]): string {
  const formatted = chain
    .map(formatLocatorSelector)
    .filter((part): part is string => Boolean(part));

  return formatted.length ? formatted.join(".") : "locator('')";
}

function formatLocatorSelector(selector: LocatorSelector): string | null {
  if (selector.strategy === "control" && selector.value === "describe") {
    return null;
  }

  if (selector.strategy === "css") {
    switch (selector.label) {
      case "alt":
        return formatTextLocatorCall("getByAltText", selector);
      case "label":
        return formatTextLocatorCall("getByLabel", selector);
      case "placeholder":
        return formatTextLocatorCall("getByPlaceholder", selector);
      case "testId":
        return formatTextLocatorCall("getByTestId", selector);
      case "title":
        return formatTextLocatorCall("getByTitle", selector);
      default:
        return `locator(${quote(selector.value)})`;
    }
  }

  if (selector.strategy === "text") {
    return formatTextLocatorCall("getByText", selector);
  }

  if (selector.strategy === "role") {
    const options = formatLocatorOptions([
      formatMaybeRegexOption("name", selector.name, selector.nameIsRegex, selector.nameRegexFlags),
      typeof selector.name === "string" && selector.exact ? "exact: true" : null
    ]);
    return `getByRole(${quote(selector.value)}${options})`;
  }

  if (selector.strategy === "control") {
    if (selector.value === "enter-frame") {
      return "contentFrame()";
    }
    if (selector.value === "chain" && selector.hasChain) {
      return `locator(${formatLocatorChain(selector.hasChain)})`;
    }
    if (selector.value === "and" && selector.hasChain) {
      return `and(${formatLocatorChain(selector.hasChain)})`;
    }
    if (selector.value === "or" && selector.hasChain) {
      return `or(${formatLocatorChain(selector.hasChain)})`;
    }
    if (selector.value === "has" && selector.hasChain) {
      return `filter({ has: ${formatLocatorChain(selector.hasChain)} })`;
    }
    if (selector.value === "has-not" && selector.hasChain) {
      return `filter({ hasNot: ${formatLocatorChain(selector.hasChain)} })`;
    }
    return `locator(${quote(`internal:control=${selector.value}`)})`;
  }

  return `locator(${quote(`${selector.strategy}=${selector.value}`)})`;
}

function formatTextLocatorCall(method: string, selector: LocatorSelector): string {
  const value = formatMaybeRegexValue(selector.value, selector.isRegex, selector.regexFlags);
  const options = typeof selector.value === "string" && selector.exact
    ? ", { exact: true }"
    : "";
  return `${method}(${value}${options})`;
}

function formatMaybeRegexOption(
  name: string,
  value: string | undefined,
  isRegex: boolean | undefined,
  flags: string | undefined
): string | null {
  if (value === undefined) {
    return null;
  }
  return `${name}: ${formatMaybeRegexValue(value, isRegex, flags)}`;
}

function formatMaybeRegexValue(
  value: string,
  isRegex: boolean | undefined,
  flags: string | undefined
): string {
  return isRegex ? `/${value.replace(/\//g, "\\/")}/${flags ?? ""}` : quote(value);
}

function formatLocatorOptions(options: Array<null | string>): string {
  const filtered = options.filter((option): option is string => Boolean(option));
  return filtered.length ? `, { ${filtered.join(", ")} }` : "";
}

function quote(value: string): string {
  return `'${JSON.stringify(value).slice(1, -1).replace(/'/g, "\\'")}'`;
}
