import { RoxyElementHandle } from "./elementHandle.js";
import type { ElementHandle } from "./types/api.js";
import type { SelectOptionValue } from "./types/options.js";

export type SelectOptionInput =
  | null
  | string
  | SelectOptionValue
  | ElementHandle
  | ReadonlyArray<string | SelectOptionValue | ElementHandle | null>;

export type NormalizedSelectOption = {
  index?: number;
  label?: string;
  value?: string;
};

export async function normalizeSelectOptionValues(
  select: ElementHandle,
  values: SelectOptionInput
): Promise<NormalizedSelectOption[]> {
  if (values === null) {
    return [];
  }

  const entries = Array.isArray(values) ? values : [values];
  const normalized: NormalizedSelectOption[] = [];
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    const prefix = `options[${index}]`;

    if (entry instanceof RoxyElementHandle) {
      const optionIndex = await select.evaluate((selectElement, optionElement) => {
        if (!(selectElement instanceof HTMLSelectElement)) {
          throw new Error("Element is not a <select> element.");
        }
        if (!(optionElement instanceof HTMLOptionElement)) {
          throw new Error("Element is not an <option> element.");
        }
        return Array.from(selectElement.options).indexOf(optionElement);
      }, entry);
      if (optionIndex === -1) {
        throw new Error("Option element is not in the <select> element.");
      }
      normalized.push({ index: optionIndex });
      continue;
    }

    normalized.push(normalizeSelectOptionValue(entry, prefix));
  }

  return normalized;
}

function normalizeSelectOptionValue(value: unknown, prefix: string): NormalizedSelectOption {
  if (typeof value === "string") {
    return { value };
  }
  if (!value || typeof value !== "object") {
    throw new Error(`${prefix}: expected object, got ${value === null ? "null" : typeof value}`);
  }

  const candidate = value as { index?: unknown; label?: unknown; value?: unknown };
  const normalized: NormalizedSelectOption = {};
  if (candidate.value !== undefined) {
    if (typeof candidate.value !== "string") {
      throw new Error(`${prefix}.value: expected string, got ${typeof candidate.value}`);
    }
    normalized.value = candidate.value;
  }
  if (candidate.label !== undefined) {
    if (typeof candidate.label !== "string") {
      throw new Error(`${prefix}.label: expected string, got ${typeof candidate.label}`);
    }
    normalized.label = candidate.label;
  }
  if (candidate.index !== undefined) {
    if (typeof candidate.index !== "number" || !Number.isInteger(candidate.index)) {
      throw new Error(`${prefix}.index: expected integer, got ${typeof candidate.index}`);
    }
    normalized.index = candidate.index;
  }
  return normalized;
}
