import type { ClickTarget } from "../types.js";
import type { McpRuntime } from "../runtime.js";
import type { Context } from "./context.js";
import type { ModalState } from "./tool.js";
import { waitForCompletion } from "./utils.js";

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

  async hover(_options?: { timeout?: number }): Promise<void> {
    await this.runtime.hover(this.target);
  }

  async selectOption(values: string[], _options?: { timeout?: number }): Promise<string[]> {
    const result = await this.runtime.selectOption(this.target, values);
    return result.selected;
  }

  async dragTo(target: Locator, _options?: { timeout?: number }): Promise<void> {
    await this.runtime.drag(this.target, target.target);
  }

  async fill(value: string, _options?: { timeout?: number }): Promise<void> {
    await this.runtime.type(this.target, value);
  }

  async pressSequentially(value: string, _options?: { timeout?: number }): Promise<void> {
    await this.runtime.type(this.target, value, { slowly: true });
  }

  async type(value: string, options?: { submit?: boolean; slowly?: boolean; timeout?: number }): Promise<void> {
    await this.runtime.type(this.target, value, {
      ...(options?.submit !== undefined ? { submit: options.submit } : {}),
      ...(options?.slowly !== undefined ? { slowly: options.slowly } : {})
    });
  }
}

function resolvedLocator(target: string, resolved: ClickTarget): string {
  if ("selector" in resolved) {
    return `locator(${JSON.stringify(resolved.selector)})`;
  }
  return `locator(${JSON.stringify(`aria-ref=${target}`)})`;
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
    const target = this.context.runtime.resolveTarget(params.target);
    return {
      locator: new Locator(this.context.runtime, params.target),
      resolved: resolvedLocator(params.target, target)
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
}
