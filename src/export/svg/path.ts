// Path geometry for the SVG renderer. Pure — no DOM, no map model.
// Consumers: svg.ts (and eventually the split render pipeline).

import { isFirstBezier, isSecondBezier, isFirstHolePoint } from '../../map/coord.js'

type Coord = ArrayLike<number>
type Transform = (coord: Coord) => Coord

/** Convert a coordinate list (with bezier / hole-point flags) into an SVG
 *  path `d` attribute. */
export function coordsToPath(
  coordinates: Coord[],
  transform: Transform = (c) => c,
): string {
  if (!coordinates.length) return ''

  const commands: string[] = []
  let cp1: Coord | null = null
  let cp2: Coord | null = null

  coordinates.forEach((coord, index) => {
    const transformed = transform(coord)

    if (index === 0 || isFirstHolePoint(coord as any)) {
      commands.push(`M ${transformed[0]} ${transformed[1]}`)
      cp1 = null
      cp2 = null
      return
    }

    if (isFirstBezier(coord as any)) { cp1 = transformed; return }
    if (isSecondBezier(coord as any)) { cp2 = transformed; return }

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

export interface PathSegment {
  start: Coord
  end: Coord
  length: number
}

export function pathLength(coords: Coord[]): number {
  return pathSegments(coords).reduce((total, s) => total + s.length, 0)
}

export function pointAndAngleAt(coords: Coord[], distance: number): { 0: number; 1: number; angle: number } {
  const segments = pathSegments(coords)
  let traversed = 0

  for (const segment of segments) {
    const { start, end, length } = segment
    const dx = end[0] - start[0]
    const dy = end[1] - start[1]
    if (traversed + length >= distance) {
      const ratio = (distance - traversed) / length
      return { 0: start[0] + dx * ratio, 1: start[1] + dy * ratio, angle: Math.atan2(dy, dx) }
    }
    traversed += length
  }

  const last = segments[segments.length - 1]
  if (!last) {
    const point = coords[0] || ([0, 0] as unknown as Coord)
    return { 0: point[0], 1: point[1], angle: 0 }
  }
  const { start, end } = last
  return { 0: end[0], 1: end[1], angle: Math.atan2(end[1] - start[1], end[0] - start[0]) }
}

export function pathSegments(coords: Coord[]): PathSegment[] {
  const segments: PathSegment[] = []
  if (coords.length < 2) return segments

  let current: Coord = coords[0]
  let cp1: Coord | null = null
  let cp2: Coord | null = null

  for (let i = 1; i < coords.length; i++) {
    const coord = coords[i]

    if (isFirstHolePoint(coord as any)) {
      current = coord
      cp1 = null
      cp2 = null
      continue
    }

    if (isFirstBezier(coord as any)) { cp1 = coord; continue }
    if (isSecondBezier(coord as any)) { cp2 = coord; continue }

    if (cp1 && cp2) {
      let previous = current
      for (let step = 1; step <= 16; step++) {
        const next = cubicBezierPoint(current, cp1, cp2, coord, step / 16)
        addPathSegment(segments, previous, next)
        previous = next
      }
      current = coord
      cp1 = null
      cp2 = null
      continue
    }

    addPathSegment(segments, current, coord)
    current = coord
  }

  return segments
}

export function addPathSegment(segments: PathSegment[], start: Coord, end: Coord): void {
  const length = Math.hypot(end[0] - start[0], end[1] - start[1])
  if (length > 0) segments.push({ start, end, length })
}

export function cubicBezierPoint(p0: Coord, p1: Coord, p2: Coord, p3: Coord, t: number): Coord {
  const mt = 1 - t
  const mt2 = mt * mt
  const t2 = t * t
  return [
    mt2 * mt * p0[0] + 3 * mt2 * t * p1[0] + 3 * mt * t2 * p2[0] + t2 * t * p3[0],
    mt2 * mt * p0[1] + 3 * mt2 * t * p1[1] + 3 * mt * t2 * p2[1] + t2 * t * p3[1],
  ]
}

export function lineAngleStart(coords: Coord[]): number {
  const first = pathSegments(coords)[0]
  if (!first) return 0
  return Math.atan2(first.end[1] - first.start[1], first.end[0] - first.start[0])
}

export function lineAngleEnd(coords: Coord[]): number {
  const segments = pathSegments(coords)
  const last = segments[segments.length - 1]
  if (!last) return 0
  return Math.atan2(last.end[1] - last.start[1], last.end[0] - last.start[0])
}
