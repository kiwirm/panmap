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

export function lineJoinToSvg(lineStyle = 0): string {
  switch (lineStyle) {
    case 1:
    case 3:
      return 'round'
    case 4:
      return 'miter'
    default:
      return 'bevel'
  }
}

export function lineCapToSvg(lineStyle = 0): string {
  return lineStyle === 1 ? 'round' : 'butt'
}
