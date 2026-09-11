/**
 * Round a value to at most 3 decimal places, leaving integers untouched.
 * Keeps serialised coordinates/measurements compact and deterministic.
 * Shared by the OMap and gitmap writers.
 */
export function cleanNumber(value: unknown): number {
  const n = Number(value)
  return Number.isInteger(n) ? n : Number(n.toFixed(3))
}
