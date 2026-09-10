/**
 * Hole-flag position codec — inverse-pair property tests.
 *
 * `shiftHoleFlagsToOcad` (write) and `shiftHoleFlagsFromOcad` (read) must be
 * exact inverses on real data: `fromOcad(toOcad(x)) === x`. This is the guard
 * that keeps the two directions in sync — the bug they fix was the writer
 * shifting hole flags forward with no reader shifting them back, so every OCAD
 * round-trip walked area holes one coord further.
 *
 * @typedef {import('../node_modules/ava/types/test-fn').ExecutionContext} ExecutionContext
 */
import test from 'ava'
import {
  shiftHoleFlagsToOcad,
  shiftHoleFlagsFromOcad,
} from '../src/formats/ocad/codecs/index.ts'
import { YFLAG_FIRST_HOLE_POINT } from '../src/panmap/coord.ts'

const HOLE = YFLAG_FIRST_HOLE_POINT // 0x02
const CORNER = 0x01
const DASH = 0x08

// Build a coord array from a list of yFlags values.
const coords = (...yFlags) => yFlags.map(y => ({ x: 0, y: 0, yFlags: y }))
const flags = arr => arr.map(c => c.yFlags ?? 0)

test('write shifts an interior hole flag last-of-prev → first-of-new', t => {
  // canonical: flag on index 2 (last coord of ring [0..2]); ring [3..5] follows
  const out = shiftHoleFlagsToOcad(coords(0, 0, HOLE, 0, 0, 0))
  t.deepEqual(flags(out), [0, 0, 0, HOLE, 0, 0])
})

test('read is the exact inverse of write (single interior hole)', t => {
  const canonical = coords(0, 0, HOLE, 0, 0, 0)
  const roundTrip = shiftHoleFlagsFromOcad(shiftHoleFlagsToOcad(canonical))
  t.deepEqual(flags(roundTrip), [0, 0, HOLE, 0, 0, 0])
})

test('inverse holds for multiple and adjacent hole rings, preserving other bits', t => {
  // Hole flags sit at interior indices only (a real area ring needs ≥3 points,
  // so the last ring's boundary flag lands at ≤ n-3, never on the final coord).
  const canonical = coords(0, CORNER, HOLE, HOLE, 0, DASH, HOLE, 0, 0, 0)
  const roundTrip = shiftHoleFlagsFromOcad(shiftHoleFlagsToOcad(canonical))
  t.deepEqual(flags(roundTrip), [0, CORNER, HOLE, HOLE, 0, DASH, HOLE, 0, 0, 0])
})

test('a last-coord hole flag (closed-line ClosePoint) is left untouched by both', t => {
  // This is the case my first fix got wrong: the forward shift never moves a
  // last-coord flag (it is only ever a shift target), so the reader must not
  // move it either, or closed lines corrupt.
  const closedLine = coords(0, 0, 0, 0, HOLE)
  t.deepEqual(flags(shiftHoleFlagsToOcad(closedLine.map(c => ({ ...c })))), [0, 0, 0, 0, HOLE])
  t.deepEqual(flags(shiftHoleFlagsFromOcad(closedLine.map(c => ({ ...c })))), [0, 0, 0, 0, HOLE])
})

test('inverse holds across randomised interior-hole layouts', t => {
  // Deterministic pseudo-random (no Date/Math.random needed): flags at various
  // interior positions, never index 0 (never a hole start) or the last coord.
  for (let seed = 1; seed <= 200; seed++) {
    const n = 5 + (seed % 12)
    const arr = coords(...Array.from({ length: n }, () => 0))
    // sprinkle hole flags at realistic interior indices (1..n-3: a ring needs
    // ≥3 points so a boundary flag never lands on the last two coords) plus
    // incidental corner/dash bits anywhere interior.
    for (let i = 1; i < n - 1; i++) {
      if (i <= n - 3 && (seed * 7 + i * 13) % 5 === 0) arr[i].yFlags |= HOLE
      if ((seed * 3 + i * 5) % 7 === 0) arr[i].yFlags |= CORNER
    }
    const before = flags(arr)
    const after = flags(shiftHoleFlagsFromOcad(shiftHoleFlagsToOcad(arr)))
    t.deepEqual(after, before, `seed ${seed}`)
  }
})
