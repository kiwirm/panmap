/**
 * Flatten xmap-shaped nested line-decoration symbols
 * (`<line_symbol><mid_symbol><symbol><point_symbol>…</point_symbol></symbol>`
 * etc.) into the OCD-flat element array shape used by `line-elements`
 * render layers.
 *
 * Runs at OMap READ time so the canonical Panmap model carries only the
 * shape both source formats agree on: a `line-elements` layer with
 * `primSymElements` / `startSymElements` / `endSymElements` /
 * `cornerSymElements` arrays of `{ type, color, coords, … }` primitives.
 * The prior architecture parked the raw xmap subtree on a `line-symbols`
 * layer's `lineSymbol` field and flattened at gitmap-write time; that
 * leaked source-format-specific data into the model and let the OMap
 * writer secretly prefer it over the canonical form.
 *
 * Coord orientation: emitted coords are y-UP, matching the canonical
 * model convention documented in the gitmap serializer ("Element coords
 * are symbol-internal (y-up)") and OCD binary. XMap XML stores element
 * coords y-DOWN (opposite convention from OCD binary for the same
 * geometry), so this flatten NEGATES y on the way in. The OMap writer's
 * `ocadElementToXmapElement` re-negates on the way out.
 */

import { encodeOcadElementFlags } from '../../ocad/codecs/element-flags.js'

interface XmapLineDecorInput {
  symbol?: {
    pointSymbol?: {
      innerColor?: unknown
      innerRadius?: number
      outerColor?: unknown
      outerWidth?: number
      elements?: unknown[]
    }
    lineSymbol?: {
      color?: unknown
      lineWidth?: number
      capStyle?: number
      joinStyle?: number
    }
    areaSymbol?: { color?: unknown; innerColor?: unknown }
  }
  object?: {
    coords?: Array<{ x?: number; y?: number } | [number?, number?]>
  }
}

// Symbol-internal element coords land in OCAD as integers (whole 0.01mm
// units); OMap keeps them as float. Round to integer to match — object
// geometry precision lives elsewhere.
//
// Note: an earlier version snapped to a 5-unit grid here to hide encoder
// disagreements between OCAD-written and Mapper-written files (kura 111
// y=14 vs 13, etc). That belongs at gitmap-canonicalise time (see
// `gitmap/writer/from-panmap/canonicalise.ts:snapSymCoord`), not at the
// reader — snapping here corrupted exact xmap→ocd values that Mapper
// preserves verbatim (retaining-wall 105.200 primSymElement coords like
// y=110/-110 → snapped to 100/-100 = wrong OCD y=10/-10 instead of 11/-11).
function snapSymCoord(v: number): number {
  return Math.round(v)
}

/**
 * Translate an xmap-shape coord array (with `.flags` bytes) into the
 * OCD-flat coord shape `{x, y, xFlags, yFlags}` used by primSymElements
 * / cornerSymElements / etc. Preserves bezier / dash / hole flags so
 * mid_symbol icon paths that carry curves (butlers 513.2 Retained wall's
 * semi-circle) survive flattening — otherwise the flags dropped here
 * meant xmap-sourced gitmap emitted straight-polygon primSymElements
 * where OCD-sourced siblings had `{control:true}` markers, diverging
 * on every curved line-decoration.
 */
function mapAndFlagCoord(
  c: { x?: number; y?: number; flags?: number } | [number?, number?],
  i: number,
  all: Array<{ x?: number; y?: number; flags?: number } | [number?, number?]>,
): { x: number; y: number; xFlags: number; yFlags: number } {
  const flagsOf = (co: unknown): number => {
    if (!co || typeof co !== 'object' || Array.isArray(co)) return 0
    return Number((co as { flags?: number }).flags ?? 0)
  }
  const x = Array.isArray(c) ? (c[0] ?? 0) : (c?.x ?? 0)
  const y = Array.isArray(c) ? (c[1] ?? 0) : (c?.y ?? 0)
  let xFlags = 0
  let yFlags = 0
  if (i >= 1 && flagsOf(all[i - 1]) & 0x01) xFlags |= 0x01
  if (i >= 2 && flagsOf(all[i - 2]) & 0x01) xFlags |= 0x02
  const own = flagsOf(c)
  if (own & 0x20) yFlags |= 0x01
  return { x: snapSymCoord(x), y: -snapSymCoord(y), xFlags, yFlags }
}

function isRealColor(v: unknown): boolean {
  if (v === undefined || v === null) return false
  if (typeof v === 'number') return v >= 0
  return typeof v === 'string' && v.length > 0
}

function flattenXmapLineDecorElement(el: unknown): unknown[] {
  if (!el || typeof el !== 'object') return []
  const e = el as XmapLineDecorInput
  const sym = e.symbol
  if (!sym) return []
  const rawCoords = e.object?.coords ?? []
  const anchor = rawCoords[0]
  const anchorX = snapSymCoord(
    Array.isArray(anchor) ? (anchor[0] ?? 0) : (anchor?.x ?? 0),
  )
  const anchorY = -snapSymCoord(
    Array.isArray(anchor) ? (anchor[1] ?? 0) : (anchor?.y ?? 0),
  )

  const out: unknown[] = []
  if (sym.pointSymbol) {
    const ps = sym.pointSymbol
    const innerRadius = Number(ps.innerRadius ?? 0)
    if (innerRadius > 0 && isRealColor(ps.innerColor)) {
      out.push({
        type: 4,
        flags: 0,
        color: ps.innerColor,
        lineWidth: 0,
        diameter: innerRadius * 2,
        numberCoords: 1,
        coords: [{ x: anchorX, y: anchorY }],
      })
    }
    const outerWidth = Number(ps.outerWidth ?? 0)
    if (outerWidth > 0 && isRealColor(ps.outerColor)) {
      out.push({
        type: 3,
        flags: 0,
        color: ps.outerColor,
        lineWidth: outerWidth,
        diameter: innerRadius * 2 + outerWidth,
        numberCoords: 1,
        coords: [{ x: anchorX, y: anchorY }],
      })
    }
    for (const sub of ps.elements ?? [])
      out.push(...flattenXmapLineDecorElement(sub))
    return out
  }
  if (sym.lineSymbol) {
    const coords = rawCoords.map((c, i) => mapAndFlagCoord(c, i, rawCoords))
    return [
      {
        type: 1,
        flags: encodeOcadElementFlags(
          sym.lineSymbol.capStyle,
          sym.lineSymbol.joinStyle,
        ),
        color: sym.lineSymbol.color,
        lineWidth: sym.lineSymbol.lineWidth ?? 0,
        diameter: 0,
        numberCoords: coords.length,
        coords,
      },
    ]
  }
  if (sym.areaSymbol) {
    const coords = rawCoords.map((c, i) => mapAndFlagCoord(c, i, rawCoords))
    return [
      {
        type: 2,
        flags: 0,
        color: sym.areaSymbol.color ?? sym.areaSymbol.innerColor,
        lineWidth: 0,
        diameter: 0,
        numberCoords: coords.length,
        coords,
      },
    ]
  }
  return []
}

/** Flatten a single OMap `<mid_symbol>` / `<start_symbol>` / `<end_symbol>`
 *  / `<dash_symbol>` subtree (already parsed to the nested xmap point-symbol
 *  shape) into a flat OCD-style element array. */
export function flattenXmapDecorSubtree(sub: unknown): unknown[] {
  if (!sub || typeof sub !== 'object') return []
  return flattenXmapLineDecorElement({
    symbol: sub,
    object: { coords: [{ x: 0, y: 0 }] },
  })
}

/**
 * Point-symbol elements (`<point_symbol><element>...</element>`) are read
 * from xmap as nested `{symbol, object}` records with `object.coords[i].y`
 * in XMap's element XML convention (y-DOWN). The canonical model contract
 * for element coords is y-UP (see docstring above). Recursively negate the
 * y-coord on every nested element in place so the OCD writer can pass
 * xmap-sourced elements through unchanged (its `translateXmapCoords`
 * expects canonical y-up input). The OMap writer's xmap-shape pass-through
 * path re-negates on output to restore xmap's y-down convention.
 *
 * This mirrors what `flattenXmapDecorSubtree` does for line-decoration
 * subtrees — the two callers just differ in whether the nested structure
 * gets flattened (line-decor) or preserved (point-symbol icons that may
 * contain compound children).
 */
export function normalisePointElementsYUp(elements: unknown): void {
  if (!Array.isArray(elements)) return
  for (const el of elements) {
    if (!el || typeof el !== 'object') continue
    const e = el as {
      symbol?: {
        pointSymbol?: { elements?: unknown[] }
      }
      object?: { coords?: Array<{ y?: number } | [unknown, number?]> }
    }
    const coords = e.object?.coords
    if (Array.isArray(coords)) {
      for (const c of coords) {
        if (Array.isArray(c)) {
          if (typeof c[1] === 'number') c[1] = -c[1]
        } else if (c && typeof c.y === 'number') {
          c.y = -c.y
        }
      }
    }
    const nested = e.symbol?.pointSymbol?.elements
    if (Array.isArray(nested)) normalisePointElementsYUp(nested)
  }
}
