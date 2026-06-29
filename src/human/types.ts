import type {
  ClickOptions,
  FillOptions,
  HoverOptions,
  HumanizationOptions,
  PressOptions,
  TypeOptions
} from "../types/options.js";

export interface ResolvedHumanizationOptions {
  profile: "cautious" | "balanced" | "fast";
  moveJitterMs: number;
  clickHoldMs: number;
  scrollStepPx: number;
  typingDelayMs: number;
  typingVarianceMs: number;
  hoverBeforeClickMs: number;
}

export interface HumanActionTarget {
  click(options?: ClickOptions): Promise<void>;
  hover(options?: HoverOptions): Promise<void>;
  fill(value: string, options?: FillOptions): Promise<void>;
  type(value: string, options?: TypeOptions): Promise<void>;
  press(key: string, options?: PressOptions): Promise<void>;
}

export interface HumanController {
  click(target: HumanActionTarget, options?: ClickOptions): Promise<void>;
  hover(target: HumanActionTarget, options?: HoverOptions): Promise<void>;
  fill(target: HumanActionTarget, value: string, options?: FillOptions): Promise<void>;
  type(target: HumanActionTarget, value: string, options?: TypeOptions): Promise<void>;
  press(target: HumanActionTarget, key: string, options?: PressOptions): Promise<void>;
}

export type HumanizationOverride = HumanizationOptions | undefined;

export type HumanActionOptions =
  | ClickOptions
  | HoverOptions
  | FillOptions
  | TypeOptions
  | PressOptions;
