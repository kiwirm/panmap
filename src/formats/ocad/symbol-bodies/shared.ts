import type { OcadElement } from '../write/encode-symbol-element.js'

export type OcadAnchor = { 0: number; 1: number; xFlags: number; yFlags: number }
export type XmapCoordInput =
  | { x?: number; y?: number; flags?: number }
  | [number, number]

export type XmapPointSymbolLike = {
  innerColor?: unknown
  innerRadius?: number
  outerColor?: unknown
  outerWidth?: number
  elements?: unknown[]
}
export type XmapLineSymbolLike = {
  color?: unknown
  lineWidth?: number
  capStyle?: number
  joinStyle?: number
}
export type XmapAreaSymbolLike = { innerColor?: unknown }
export type XmapElementInput = {
  symbol?: {
    pointSymbol?: XmapPointSymbolLike
    lineSymbol?: XmapLineSymbolLike
    areaSymbol?: XmapAreaSymbolLike
  }
  object?: {
    coords?: Array<{ x?: number; y?: number; flags?: number } | [number, number]>
  }
}

export type ColorNumber = (id: unknown) => number

export type { OcadElement }

/**
 * Canonical widths / distances are already in OCAD units (0.01 mm) when
 * the source is OCAD or xmap; gitmap stores them the same way for
 * round-trip. Clamp to a 16-bit signed range so writer's SmallInt
 * output doesn't wrap.
 */
export function normUnits(v: unknown): number {
  const n = Number(v)
  if (!Number.isFinite(n)) return 0
  const rounded = Math.round(n)
  if (rounded > 32767) return 32767
  if (rounded < -32768) return -32768
  return rounded
}
