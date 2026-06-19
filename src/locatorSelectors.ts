import type { LocatorSelector } from "./protocol/adapter.js";
import type {
  GetByAltTextOptions,
  GetByLabelOptions,
  GetByPlaceholderOptions,
  GetByRoleOptions,
  GetByTextOptions,
  GetByTitleOptions
} from "./types/options.js";

type TextMatchOptions =
  | GetByAltTextOptions
  | GetByLabelOptions
  | GetByPlaceholderOptions
  | GetByTextOptions
  | GetByTitleOptions;

function withPattern(
  base: Omit<LocatorSelector, "value">,
  value: string | RegExp,
  options?: TextMatchOptions
): LocatorSelector {
  return {
    ...base,
    value: value instanceof RegExp ? value.source : value,
    ...(options?.exact !== undefined ? { exact: options.exact } : {}),
    ...(value instanceof RegExp
      ? {
          isRegex: true,
          regexFlags: value.flags
        }
      : {})
  };
}

export function createTextLocatorSelector(
  text: string | RegExp,
  options?: GetByTextOptions
): LocatorSelector {
  return createInternalTextLocatorSelector(text, options);
}

export function createInternalTextLocatorSelector(
  text: string | RegExp,
  options?: GetByTextOptions
): LocatorSelector {
  return withPattern({ strategy: "text", internal: true }, text, options);
}

export function createAltTextLocatorSelector(
  text: string | RegExp,
  options?: GetByAltTextOptions
): LocatorSelector {
  return withPattern({ strategy: "css", label: "alt" }, text, options);
}

export function createLabelLocatorSelector(
  text: string | RegExp,
  options?: GetByLabelOptions
): LocatorSelector {
  return withPattern({ strategy: "css", label: "label" }, text, options);
}

export function createPlaceholderLocatorSelector(
  text: string | RegExp,
  options?: GetByPlaceholderOptions
): LocatorSelector {
  return withPattern({ strategy: "css", label: "placeholder" }, text, options);
}

export function createTestIdLocatorSelector(testId: string | RegExp): LocatorSelector {
  return withPattern({ strategy: "css", label: "testId" }, testId);
}

export function createRoleLocatorSelector(
  role: string,
  options?: GetByRoleOptions
): LocatorSelector {
  return {
    strategy: "role",
    value: role,
    ...(options?.exact !== undefined ? { exact: options.exact } : {}),
    ...(typeof options?.name === "string" ? { name: options.name } : {}),
    ...(options?.name instanceof RegExp
      ? {
          name: options.name.source,
          nameIsRegex: true,
          nameRegexFlags: options.name.flags
        }
      : {})
  };
}

export function createTitleLocatorSelector(
  text: string | RegExp,
  options?: GetByTitleOptions
): LocatorSelector {
  return withPattern({ strategy: "css", label: "title" }, text, options);
}
