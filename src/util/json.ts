/**
 * Recursively sort object keys so JSON serialisation is deterministic.
 * Used by both the gitmap writer (via stable-json) and the extensions
 * formatter. Arrays keep their order; scalars are returned as-is.
 */
export function sortDeep<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((v) => sortDeep(v)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => [k, sortDeep(v)] as const);
    return Object.fromEntries(entries) as T;
  }
  return value;
}
