/**
 * OCAD packs two orthogonal stroke properties — cap style and join
 * style — into a single `lineStyle` byte per line symbol. XMap and
 * carry them independently, so the pair has to be encoded
 * on write and decoded on read.
 *
 * Enum values (from OCAD):
 *   cap : 0=Flat  1=Round  2=Square  3=Pointed
 *   join: 0=Bevel 1=Miter  2=Round
 *
 * Empirical byte mapping matches Mapper's own output:
 *   0 → cap=0 join=0     4 → cap=0 join=1
 *   1 → cap=1 join=2     6 → cap=3 join=1
 *   2 → cap=3 join=0
 *   3 → cap=3 join=2
 */

export interface CapJoin {
  capStyle?: number
  joinStyle?: number
}

const BYTE_TO_CAP_JOIN: Record<number, CapJoin> = {
  0: { capStyle: 0, joinStyle: 0 },
  1: { capStyle: 1, joinStyle: 2 },
  2: { capStyle: 3, joinStyle: 0 },
  3: { capStyle: 3, joinStyle: 2 },
  4: { capStyle: 0, joinStyle: 1 },
  6: { capStyle: 3, joinStyle: 1 },
}

/**
 * Decode an OCAD `lineStyle` byte into independent cap/join. Returns
 * an empty object for undefined / unrecognised inputs so callers can
 * safely spread the result into a wider shape.
 */
export function decodeLineStyle(v: number | undefined): CapJoin {
  return v === undefined ? {} : (BYTE_TO_CAP_JOIN[v] ?? {})
}

/**
 * Encode a cap/join pair into the OCAD `lineStyle` byte. Missing
 * fields default to 0. For pairs that don't match a known byte, fall
 * back to cap-only dispatch (mirrors Mapper's own fallback path):
 *   cap=0 → 0, cap=1 → 1, cap=3 → 3, otherwise 0.
 */
export function encodeLineStyle(cap?: number, join?: number): number {
  const c = cap ?? 0
  const j = join ?? 0
  if (c === 0 && j === 0) return 0
  if (c === 1 && j === 2) return 1
  if (c === 3 && j === 0) return 2
  if (c === 3 && j === 2) return 3
  if (c === 0 && j === 1) return 4
  if (c === 3 && j === 1) return 6
  if (c === 0) return 0
  if (c === 1) return 1
  if (c === 3) return 3
  return 0
}
