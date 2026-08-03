import type { RenderLayer, StrokeLayer } from '../map/render-layers.js'

/**
 * A stroke has a "valid" color when its colorId is a non-negative number
 * or a non-empty string. Numeric `-1` and `null`/`undefined` are xmap's
 * "no color" sentinels — the stroke exists structurally (e.g. to attach
 * borders) but should not paint.
 */
export function strokeColorValid(stroke: StrokeLayer | undefined): boolean {
  if (!stroke) return false
  const c = stroke.colorId
  if (c === undefined || c === null) return false
  if (typeof c === 'number') return c >= 0
  return typeof c === 'string' && c.length > 0
}

/**
 * "Visible" is the render-layer sense used by xmap: has a valid color
 * AND a positive width. Used when picking a paintable primary stroke
 * for xmap-side symbol assembly.
 */
export function strokeVisible(stroke: RenderLayer): boolean {
  const c = stroke.colorId
  if (c === undefined || c === null) return false
  if (typeof c === 'number') {
    return c >= 0 && (stroke.width as number | undefined ?? 0) > 0
  }
  return typeof c === 'string' && c.length > 0
}

function hasBorders(s: StrokeLayer): boolean {
  const b = s.borders
  return Array.isArray(b) && b.length > 0
}

/**
 * Pick the "main" stroke of a combined line symbol. Preferences:
 *   1. First DASHED stroke with a valid color AND no borders (Mapper
 *      picks these — e.g. railway 509's dashed foreground). The
 *      border-carrying stroke belongs in the double-line block, not
 *      the main line. Stairways (ISOM 532) illustrate why: their only
 *      visible stroke also carries borders, so treating it as main
 *      line would double-draw it.
 *   2. First stroke with a valid color AND no borders.
 *   3. First stroke with a valid color (if all visible strokes carry
 *      borders, we still need one — but this case is rare).
 *   4. First stroke (falls through to `deriveDoubleLine` for shape).
 */
export function pickMainStroke(strokes: StrokeLayer[]): StrokeLayer | undefined {
  if (!strokes.length) return undefined
  const isDashed = (s: StrokeLayer): boolean => !!s.dash
  const isFrame = (s: StrokeLayer): boolean => !!(s as { frame?: boolean }).frame
  const visible = (s: StrokeLayer): boolean =>
    strokeColorValid(s) && !hasBorders(s) && !isFrame(s)
  for (const s of strokes) if (isDashed(s) && visible(s)) return s
  for (const s of strokes) if (visible(s)) return s
  for (const s of strokes) if (strokeColorValid(s) && !isFrame(s)) return s
  return strokes[0]
}

/**
 * Whether the picked "main" stroke should paint (lineColor + lineWidth
 * non-zero). It's invisible only when it has borders AND there's a
 * *separate* visible+borderless stroke, OR an explicit invisible
 * placeholder — those are the stairway / power-line cases where all
 * visible width belongs in the double-line block. A lone stroke with
 * borders (like 502.x roads) still paints as the main line.
 */
export function mainStrokeVisible(
  stroke: StrokeLayer | undefined,
  allStrokes: StrokeLayer[],
): boolean {
  if (!stroke) return false
  if (!strokeColorValid(stroke)) return false
  if (!hasBorders(stroke)) return true
  const invisiblePlaceholder = allStrokes.some((s) => {
    if (s === stroke) return false
    const sc = s.colorId
    const invisible = sc === -1 || sc === undefined || sc === null
    return invisible && !hasBorders(s)
  })
  const borderlessAlternative = allStrokes.some((s) => {
    if (s === stroke) return false
    if (!strokeColorValid(s)) return false
    return !hasBorders(s)
  })
  return !(invisiblePlaceholder || borderlessAlternative)
}
