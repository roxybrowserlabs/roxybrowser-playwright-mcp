export function assertFillValue(value: unknown): asserts value is string {
  if (typeof value !== "string") {
    throw new Error(`value: expected string, got ${typeof value}`);
  }
}
