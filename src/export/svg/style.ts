// Line-style helpers for the SVG renderer. Pure.

export interface DashPattern {
  dashLength?: number
  breakLength?: number
  dashesInGroup?: number
  inGroupBreakLength?: number
  // OCAD-style dash description used as a fallback.
  mainLength?: number
  mainGap?: number
  secGap?: number
}

export function dashToSvg(dash: DashPattern | null | undefined): string | null {
  if (!dash) return null

  if (dash.dashLength !== undefined || dash.breakLength !== undefined) {
    const dashLength = Math.max(dash.dashLength || 0, 0)
    const breakLength = Math.max(dash.breakLength || 0, 0)
    const dashesInGroup = Math.max(dash.dashesInGroup || 1, 1)
    const inGroupBreakLength = Math.max(dash.inGroupBreakLength || 0, 0)

    if (dashesInGroup > 1 && inGroupBreakLength > 0) {
      const parts: number[] = []
      for (let i = 0; i < dashesInGroup; i++) {
        parts.push(dashLength)
        parts.push(i === dashesInGroup - 1 ? breakLength : inGroupBreakLength)
      }
      return parts.join(' ')
    }

    return dashLength || breakLength ? `${dashLength} ${breakLength}` : null
  }

  const mainGap = dash.mainGap || 0
  const secGap = dash.secGap || 0
  const mainLength = dash.mainLength || 0

  if (!mainLength || (!mainGap && !secGap)) return null

  if (secGap && !mainGap) {
    return `${mainLength - secGap} ${secGap}`
  }

  if (secGap) {
    const dashLength = (mainLength - secGap) / 2
    return `${dashLength} ${secGap} ${dashLength} ${mainGap}`
  }

  return `${mainLength} ${mainGap}`
}

// OCAD stores cap+join packed into a single `lineStyle` int; OMAP splits
// them into distinct `capStyle` / `joinStyle` fields. Layers coming from
// each source expose their native shape verbatim — one helper handles
// both by accepting the layer and preferring the explicit OMAP fields
// when present, falling back to the OCAD packed style.
type LineStyleInput = {
  lineStyle?: number
  capStyle?: number
  joinStyle?: number
} | undefined

export function lineJoinToSvg(input: number | LineStyleInput = 0): string {
  if (typeof input === 'object' && input !== null) {
    if (input.joinStyle !== undefined) {
      // OMAP: 0 bevel, 1 miter, 2 round
      switch (input.joinStyle) {
        case 1: return 'miter'
        case 2: return 'round'
        default: return 'bevel'
      }
    }
    return lineJoinToSvg(input.lineStyle ?? 0)
  }
  switch (input) {
    case 1:
    case 3:
      return 'round'
    case 4:
      return 'miter'
    default:
      return 'bevel'
  }
}

export function lineCapToSvg(input: number | LineStyleInput = 0): string {
  if (typeof input === 'object' && input !== null) {
    if (input.capStyle !== undefined) {
      // OMAP: 0 flat, 1 round, 2 square, 3 pointed(≈round-ish)
      switch (input.capStyle) {
        case 1:
        case 3:
          return 'round'
        case 2:
          return 'square'
        default: return 'butt'
      }
    }
    return lineCapToSvg(input.lineStyle ?? 0)
  }
  return input === 1 ? 'round' : 'butt'
}
