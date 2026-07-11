import type {
  ClickOptions,
  FillOptions,
  HoverOptions,
  PressOptions,
  TypeOptions
} from "../types/options.js";

export type HumanProfileName = "cautious" | "balanced" | "fast";

export interface HumanizationOptions {
  profile?: HumanProfileName;
  moveJitterMs?: number;
  clickHoldMs?: number;
  scrollStepPx?: number;
  typingDelayMs?: number;
  typingVarianceMs?: number;
  hoverBeforeClickMs?: number;
}

export interface ResolvedHumanizationOptions {
  profile: "cautious" | "balanced" | "fast";
  moveJitterMs: number;
  clickHoldMs: number;
  scrollStepPx: number;
  typingDelayMs: number;
  typingVarianceMs: number;
  hoverBeforeClickMs: number;
}

export type InternalTypingAction =
  | { type: "char"; value: string; delay: number }
  | { type: "pause"; delay: number }
  | { type: "backspace"; delay: number };

export interface HumanActionTarget {
  focus?(): Promise<void>;
  click(options?: ClickOptions): Promise<void>;
  hover(options?: HoverOptions): Promise<void>;
  clear?(): Promise<void>;
  fill(value: string, options?: FillOptions): Promise<void>;
  type(value: string, options?: TypeOptions): Promise<void>;
  press(key: string, options?: PressOptions): Promise<void>;
}

export interface HumanizedClickOptions extends ClickOptions {
  __roxyHumanMove?: {
    durationMs: number;
    stepPx: number;
  };
}

export interface HumanizedHoverOptions extends HoverOptions {
  __roxyHumanMove?: {
    durationMs: number;
    stepPx: number;
  };
}

export interface HumanizedTypeOptions extends TypeOptions {
  __roxyTypeVariance?: number;
  __roxyTypingPlan?: InternalTypingAction[];
}

export interface HumanController {
  click(target: HumanActionTarget, options?: HumanizedClickOptions & HumanActionOptions): Promise<void>;
  hover(target: HumanActionTarget, options?: HumanizedHoverOptions & HumanActionOptions): Promise<void>;
  fill(target: HumanActionTarget, value: string, options?: FillOptions & HumanActionOptions): Promise<void>;
  type(target: HumanActionTarget, value: string, options?: HumanizedTypeOptions & HumanActionOptions): Promise<void>;
  press(target: HumanActionTarget, key: string, options?: PressOptions & HumanActionOptions): Promise<void>;
}

export type HumanizationOverride = HumanizationOptions | undefined;

export type HumanActionOptions = {
  human?: HumanizationOptions;
};
