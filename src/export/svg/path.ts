// Path geometry for the SVG renderer. Pure — no DOM, no map model.
// Consumers: svg.ts (and eventually the split render pipeline).

import {
  isFirstBezier,
  isSecondBezier,
  isFirstHolePoint,
} from '../../panmap/coord.js'

type Coord = ArrayLike<number>
type Transform = (coord: Coord) => Coord

/** Convert a coordinate list (with bezier / hole-point flags) into an SVG
 *  path `d` attribute.
 *
 *  Panmap's internal convention (matching OMAP's storage format) puts the
 *  hole-point flag on the LAST coord of the previous sub-path — that coord
 *  is the geometric endpoint of the outgoing ring, and the NEXT coord
 *  supplies the M for the new hole. The OCAD writer shifts the flag by +1
 *  on the way out (see synthesize-objects.ts::shiftHoleFlagsForward).
 *
 *  Previously this function treated the flagged coord as an M — which drops
 *  the pending bezier's endpoint (the outgoing ring loses its last curve)
 *  and starts the hole at the OUTGOING RING'S closing point instead of the
 *  hole's real first coord. Under SVG's evenodd fill, the resulting
 *  synthetic straight-line closure of the outer ring plus a spurious
 *  connecting line to the true first-hole-point paints a diagonal slice of
 *  the polygon in the background colour. */
export function coordsToPath(
  coordinates: Coord[],
  transform: Transform = c => c,
): string {
  if (!coordinates.length) return ''

  const commands: string[] = []
  let cp1: Coord | null = null
  let cp2: Coord | null = null
  // Set when a hole-point coord has just been consumed as the closing
  // point of the previous sub-path: the next non-control-point coord
  // supplies the M for the new sub-path.
  let pendingM = false

  coordinates.forEach((coord, index) => {
    const transformed = transform(coord)

    if (index === 0) {
      commands.push(`M ${transformed[0]} ${transformed[1]}`)
      return
    }

    if (isFirstHolePoint(coord as any)) {
      // Close the previous sub-path by drawing to this coord's position
      // (completing any pending bezier). SVG's evenodd fill will then
      // implicitly close the sub-path from here back to the M.
      if (cp1 && cp2) {
        commands.push(
          `C ${cp1[0]} ${cp1[1]} ${cp2[0]} ${cp2[1]} ${transformed[0]} ${transformed[1]}`,
        )
      } else {
        commands.push(`L ${transformed[0]} ${transformed[1]}`)
      }
      cp1 = null
      cp2 = null
      pendingM = true
      return
    }

    if (pendingM) {
      commands.push(`M ${transformed[0]} ${transformed[1]}`)
      pendingM = false
      return
    }

    if (isFirstBezier(coord as any)) {
      cp1 = transformed
      return
    }
    if (isSecondBezier(coord as any)) {
      cp2 = transformed
      return
    }

    if (cp1 && cp2) {
      commands.push(
        `C ${cp1[0]} ${cp1[1]} ${cp2[0]} ${cp2[1]} ${transformed[0]} ${transformed[1]}`,
      )
      cp1 = null
      cp2 = null
      return
    }

    commands.push(`L ${transformed[0]} ${transformed[1]}`)
  })

  return commands.join(' ')
}

/** Flat SoA (struct-of-arrays) layout: three typed arrays holding start
 *  x/y, end x/y and cumulative length for every segment along the path.
 *  Callers that need to sample repeatedly (dash/mid symbols, arrow
 *  placement) build this once and reuse — turning what was O(vertices)
 *  per lookup into O(log vertices) via binary search, and removing the
 *  per-lookup allocation of a 6000-entry `PathSegment[]`. */
export interface PathSampler {
  count: number
  starts: Float64Array // 2·count: [x0, y0, x1, y1, ...]
  ends: Float64Array // 2·count
  cumLen: Float64Array // count: total path length up to and including segment i
  total: number
}

export function buildPathSampler(coords: Coord[]): PathSampler {
  const startsBuf: number[] = []
  const endsBuf: number[] = []
  const cumBuf: number[] = []
  let cum = 0

  const push = (sx: number, sy: number, ex: number, ey: number): void => {
    const len = Math.hypot(ex - sx, ey - sy)
    if (len <= 0) return
    startsBuf.push(sx, sy)
    endsBuf.push(ex, ey)
    cum += len
    cumBuf.push(cum)
  }

  if (coords.length >= 2) {
    let currentX = coords[0][0]
    let currentY = coords[0][1]
    let cp1: Coord | null = null
    let cp2: Coord | null = null

    for (let i = 1; i < coords.length; i++) {
      const coord = coords[i]

      if (isFirstHolePoint(coord as any)) {
        currentX = coord[0]
        currentY = coord[1]
        cp1 = null
        cp2 = null
        continue
      }

      if (isFirstBezier(coord as any)) {
        cp1 = coord
        continue
      }
      if (isSecondBezier(coord as any)) {
        cp2 = coord
        continue
      }

      if (cp1 && cp2) {
        let prevX = currentX
        let prevY = currentY
        for (let step = 1; step <= 16; step++) {
          const next = cubicBezierPoint(
            [currentX, currentY],
            cp1,
            cp2,
            coord,
            step / 16,
          )
          push(prevX, prevY, next[0], next[1])
          prevX = next[0]
          prevY = next[1]
        }
        currentX = coord[0]
        currentY = coord[1]
        cp1 = null
        cp2 = null
        continue
      }

      push(currentX, currentY, coord[0], coord[1])
      currentX = coord[0]
      currentY = coord[1]
    }
  }

  return {
    count: cumBuf.length,
    starts: Float64Array.from(startsBuf),
    ends: Float64Array.from(endsBuf),
    cumLen: Float64Array.from(cumBuf),
    total: cum,
  }
}

export function pointAndAngleAtSampler(
  sampler: PathSampler,
  distance: number,
): { 0: number; 1: number; angle: number } {
  if (sampler.count === 0) {
    return { 0: 0, 1: 0, angle: 0 }
  }
  // Binary search for the segment whose cumulative length reaches `distance`.
  let lo = 0
  let hi = sampler.count - 1
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (sampler.cumLen[mid] < distance) lo = mid + 1
    else hi = mid
  }
  const i = lo
  const sx = sampler.starts[i * 2]
  const sy = sampler.starts[i * 2 + 1]
  const ex = sampler.ends[i * 2]
  const ey = sampler.ends[i * 2 + 1]
  const prevCum = i === 0 ? 0 : sampler.cumLen[i - 1]
  const segLen = sampler.cumLen[i] - prevCum
  const dx = ex - sx
  const dy = ey - sy
  if (distance >= sampler.cumLen[sampler.count - 1]) {
    return { 0: ex, 1: ey, angle: Math.atan2(dy, dx) }
  }
  const ratio = segLen > 0 ? (distance - prevCum) / segLen : 0
  return { 0: sx + dx * ratio, 1: sy + dy * ratio, angle: Math.atan2(dy, dx) }
}

export function cubicBezierPoint(
  p0: Coord,
  p1: Coord,
  p2: Coord,
  p3: Coord,
  t: number,
): Coord {
  const mt = 1 - t
  const mt2 = mt * mt
  const t2 = t * t
  return [
    mt2 * mt * p0[0] +
      3 * mt2 * t * p1[0] +
      3 * mt * t2 * p2[0] +
      t2 * t * p3[0],
    mt2 * mt * p0[1] +
      3 * mt2 * t * p1[1] +
      3 * mt * t2 * p2[1] +
      t2 * t * p3[1],
  ]
}

export function lineAngleStartSampler(s: PathSampler): number {
  if (s.count === 0) return 0
  const sx = s.starts[0]
  const sy = s.starts[1]
  const ex = s.ends[0]
  const ey = s.ends[1]
  return Math.atan2(ey - sy, ex - sx)
}

export function lineAngleEndSampler(s: PathSampler): number {
  if (s.count === 0) return 0
  const i = s.count - 1
  const sx = s.starts[i * 2]
  const sy = s.starts[i * 2 + 1]
  const ex = s.ends[i * 2]
  const ey = s.ends[i * 2 + 1]
  return Math.atan2(ey - sy, ex - sx)
}
