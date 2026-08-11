import type { BrowserEvaluateResult, ClickTarget } from "../types.js";
import type { SessionScreenshotMimeType } from "../types.js";
import type { McpRuntime } from "../runtime.js";
import type { Context } from "./context.js";
import type { ModalState } from "./tool.js";
import { parseLocatorOrSelector } from "./locatorParser.js";
import { escapeWithQuotes, waitForCompletion } from "./utils.js";

type TargetParams = { element?: string | undefined; target: string };
type HumanOptions = { profile?: "cautious" | "balanced" | "fast" | undefined };

class Locator {
  constructor(
    private readonly runtime: McpRuntime,
    private readonly target: string
  ) {}

  async click(options?: {
    button?: "left" | "right" | "middle";
    modifiers?: Array<"Alt" | "Control" | "ControlOrMeta" | "Meta" | "Shift">;
    human?: HumanOptions;
  }): Promise<void> {
    await this.runtime.click(this.target, {
      ...(options?.button !== undefined ? { button: options.button } : {}),
      ...(options?.modifiers !== undefined ? { modifiers: options.modifiers } : {}),
      ...(options?.human?.profile !== undefined ? { human: { profile: options.human.profile } } : {})
    });
  }

  async dblclick(options?: {
    button?: "left" | "right" | "middle";
    modifiers?: Array<"Alt" | "Control" | "ControlOrMeta" | "Meta" | "Shift">;
    human?: HumanOptions;
  }): Promise<void> {
    await this.runtime.click(this.target, {
      ...(options?.button !== undefined ? { button: options.button } : {}),
      ...(options?.modifiers !== undefined ? { modifiers: options.modifiers } : {}),
      ...(options?.human?.profile !== undefined ? { human: { profile: options.human.profile } } : {}),
      doubleClick: true
    });
  }

  async hover(_options?: { timeout?: number; human?: HumanOptions }): Promise<void> {
    await this.runtime.hover(this.target);
  }

  async evaluate(expression: string): Promise<BrowserEvaluateResult> {
    return this.runtime.evaluate(expression, this.target);
  }

  getByText(text: string): LocatorTextQuery {
    return new LocatorTextQuery(this.runtime, this.target, text);
  }

  async textContent(_options?: { timeout?: number }): Promise<string | null> {
    return this.runtime.textContent(this.target);
  }

  async inputValue(_options?: { timeout?: number }): Promise<string> {
    return this.runtime.inputValue(this.target);
  }

  async isChecked(_options?: { timeout?: number }): Promise<boolean> {
    return this.runtime.isChecked(this.target);
  }

  async selectOption(values: string[], _options?: { timeout?: number }): Promise<string[]> {
    const result = await this.runtime.selectOption(this.target, values);
    return result.selected;
  }

  async dragTo(target: Locator, _options?: { timeout?: number }): Promise<void> {
    await this.runtime.drag(this.target, target.target);
  }

  async fill(value: string, options?: { timeout?: number; human?: HumanOptions }): Promise<void> {
    await this.runtime.type(this.target, value, {
      strategy: "fill",
      ...(options?.timeout !== undefined ? { timeout: options.timeout } : {}),
      ...(options?.human?.profile !== undefined ? { human: { profile: options.human.profile } } : {})
    });
  }

  async pressSequentially(value: string, options?: { timeout?: number; human?: HumanOptions }): Promise<void> {
    await this.runtime.type(this.target, value, {
      slowly: true,
      strategy: "sequential",
      ...(options?.timeout !== undefined ? { timeout: options.timeout } : {}),
      ...(options?.human?.profile !== undefined ? { human: { profile: options.human.profile } } : {})
    });
  }

  async press(key: string, options?: { timeout?: number; human?: HumanOptions }): Promise<void> {
    await this.runtime.press(
      this.target,
      key,
      options?.human?.profile !== undefined ? { profile: options.human.profile } : undefined
    );
  }

  async type(value: string, options?: {
    submit?: boolean;
    slowly?: boolean;
    timeout?: number;
    human?: HumanOptions;
  }): Promise<void> {
    await this.runtime.type(this.target, value, {
      ...(options?.submit !== undefined ? { submit: options.submit } : {}),
      ...(options?.slowly !== undefined ? { slowly: options.slowly } : {}),
      ...(options?.timeout !== undefined ? { timeout: options.timeout } : {}),
      ...(options?.human?.profile !== undefined ? { human: { profile: options.human.profile } } : {})
    });
  }
}

class LocatorTextQuery {
  constructor(
    private readonly runtime: McpRuntime,
    private readonly target: string,
    private readonly text: string
  ) {}

  async count(): Promise<number> {
    return (await this.runtime.textContentsByText(this.text, { target: this.target })).length;
  }

  async textContents(): Promise<string[]> {
    return this.runtime.textContentsByText(this.text, { target: this.target });
  }
}

function resolvedLocator(target: string, resolved: ClickTarget): string {
  if ("selector" in resolved) {
    return `locator(${escapeWithQuotes(resolved.selector)})`;
  }
  return `locator(${escapeWithQuotes(`aria-ref=${target}`)})`;
}

export class Tab {
  readonly actionTimeoutOptions: { timeout?: number };
  readonly navigationTimeoutOptions: { timeout?: number };
  readonly expectTimeoutOptions: { timeout?: number };

  constructor(readonly context: Context) {
    this.actionTimeoutOptions = context.config.timeouts?.action !== undefined
      ? { timeout: context.config.timeouts.action }
      : {};
    this.navigationTimeoutOptions = context.config.timeouts?.navigation !== undefined
      ? { timeout: context.config.timeouts.navigation }
      : {};
    this.expectTimeoutOptions = context.config.timeouts?.expect !== undefined
      ? { timeout: context.config.timeouts.expect }
      : {};
  }

  modalStates(): ModalState[] {
    if (!this.context.runtime.hasPendingFileUploadTarget()) {
      return [];
    }
    return [{
      type: "fileChooser",
      description: "File chooser",
      clearedBy: { tool: "browser_file_upload", skill: "upload" }
    }];
  }

  async waitForCompletion<T>(callback: () => Promise<T>): Promise<T> {
    return waitForCompletion(this, callback);
  }

  async waitForTimeout(time: number): Promise<void> {
    await this.context.runtime.waitForPageTimeout(time);
  }

  async waitForMainFrameLoad(timeoutMs: number): Promise<void> {
    await this.context.runtime.waitForMainFrameLoad(timeoutMs);
  }

  async waitForRequestFinished(requestId: string, timeoutMs: number): Promise<void> {
    await this.context.runtime.waitForRequestFinished(requestId, timeoutMs);
  }

  async waitForRequestResponse(requestId: string, timeoutMs: number): Promise<void> {
    await this.context.runtime.waitForRequestResponse(requestId, timeoutMs);
  }

  async targetLocator(params: TargetParams): Promise<{ locator: Locator; resolved: string }> {
    const parsed = parseLocatorOrSelector(
      params.target,
      this.context.config.testIdAttribute ?? "data-testid"
    );
    const target = this.context.runtime.resolveTarget(parsed.selector);
    return {
      locator: new Locator(this.context.runtime, parsed.selector),
      resolved: parsed.resolved ?? this.context.runtime.resolveLocatorForCode(params.target) ?? resolvedLocator(parsed.selector, target)
    };
  }

  async targetLocators(params: TargetParams[]): Promise<Array<{ locator: Locator; resolved: string }>> {
    return Promise.all(params.map((param) => this.targetLocator(param)));
  }

  async pressKey(
    key: string,
    modifiers?: Array<"Alt" | "Control" | "ControlOrMeta" | "Meta" | "Shift">
  ): Promise<void> {
    await this.context.runtime.pressKey(key, modifiers);
  }

  async uploadFile(paths: string[] | undefined): Promise<void> {
    await this.context.runtime.performFileUpload(paths);
  }

  async takeScreenshot(options?: {
    type?: "png" | "jpeg" | "webp";
    quality?: number;
    fullPage?: boolean;
    scale?: "css" | "device";
    target?: string;
  }): Promise<{ data: string; mimeType: SessionScreenshotMimeType }> {
    return this.context.takeScreenshot(options);
  }
}
