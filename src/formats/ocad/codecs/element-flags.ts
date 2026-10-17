/**
 * OCAD point-symbol element `flags` byte ↔ cap/join style. NOT a bitmask
 * — Mapper treats the byte as an enum (see the source-of-truth
 * `mapper/src/fileformats/ocd_file_import.cpp:1815` switch and the
 * write path at `ocd_file_export.cpp:1314`):
 *
 *   NoFlags        = 0  → cap=Flat(0),  join=Bevel(0)
 *   RoundStyle     = 1  → cap=Round(1), join=Round(2)
 *   FlatMiterStyle = 4  → cap=Flat(0),  join=Miter(1)
 *
 * Mapper's write rule is asymmetric with respect to the decode: any
 * `RoundCap` wins slot 1 (regardless of join); else `MiterJoin` wins
 * slot 4; else 0. That's what `encode()` implements — a cap=round,
 * join=miter element still round-trips to flags=1.
 */

export interface CapJoin {
  capStyle: number
  joinStyle: number
}

/** Decode an OCAD element `flags` byte into a cap/join pair. */
export function decodeOcadElementFlags(flags: number | undefined): CapJoin {
  if (flags === 1) return { capStyle: 1, joinStyle: 2 }
  if (flags === 4) return { capStyle: 0, joinStyle: 1 }
  return { capStyle: 0, joinStyle: 0 }
}

/** Encode a cap/join pair into an OCAD element `flags` byte. */
export function encodeOcadElementFlags(
  cap: number | undefined,
  join: number | undefined,
): number {
  if (cap === 1) return 1
  if (join === 1) return 4
  return 0
}
