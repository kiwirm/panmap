import type { RenderLayer } from '../../../../panmap/model.js'
import { cleanNumber } from '../../../../util/number.js'

// Fields to drop when canonicalising a `stroke` render layer, so an OCD- and an
// OMap-sourced copy of the same line serialise identically. The OCAD reader
// emits `lineStyle` (a packed cap+join byte that `capStyle`/`joinStyle` already
// carry, and that the SVG renderer ignores) and gates zero offsets to
// undefined; the OMap reader omits `lineStyle` but always emits the zero
// defaults. Dropping `lineStyle` + the defaults reconciles both. Non-default
// values are kept (a stroke that genuinely offsets or hides its mid-symbol).
export function strokeCanonicalDrops(layer: RenderLayer): ReadonlySet<string> {
  if ((layer as { type?: string }).type !== 'stroke') return EMPTY_DROP
  const l = layer as Record<string, unknown>
  const drop = new Set<string>(['lineStyle'])
  if (!l.minimumMidSymbolCount) drop.add('minimumMidSymbolCount')
  if (l.showAtLeastOneSymbol === true || l.showAtLeastOneSymbol === undefined) {
    drop.add('showAtLeastOneSymbol')
  }
  if (!l.startOffset) drop.add('startOffset')
  if (!l.endOffset) drop.add('endOffset')
  // Mid-symbol placement fields (`segmentLength` / `midSymbolsPerSpot` /
  // `midSymbolDistance`) only matter when the stroke actually has mid-symbol
  // elements. Both readers emit them regardless, with different defaults
  // (OCAD leaves segmentLength undefined or copies mainLength; OMap always
  // emits `400`). When no `primSymElements` array is present, drop them.
  const hasMidSymbols =
    Array.isArray(l.primSymElements) &&
    (l.primSymElements as unknown[]).length > 0
  // Top-level `endLength` is an OCAD-only slot for a special "last dash"
  // length; OMap doesn't emit it at all. Drop whenever a dash is present
  // (its vocab collapse in `canonicaliseDash` doesn't carry endLength
  // anyway) OR when it's an orphan (no dash and no mid-symbol; e.g. 509.2
  // Tramway where OMap emits `endLength: 150` as dead data).
  const dashObj = l.dash as
    { mainLength?: number; mainGap?: number; secGap?: number } | undefined
  const isOrphan = !dashObj && !hasMidSymbols
  if (!l.endLength || dashObj || isOrphan) {
    drop.add('endLength')
  }
  if (!hasMidSymbols) {
    drop.add('segmentLength')
    // No mid-symbol geometry → the count is dead data whatever its value (OCD
    // omits it; OMap may emit 0 or 1). Drop it unconditionally.
    drop.add('midSymbolsPerSpot')
    if (!l.midSymbolDistance) drop.add('midSymbolDistance')
    // `minimumMidSymbolCount` gates whether Mapper draws mid-symbols on short
    // segments; if the stroke has no mid-symbol geometry to place, the field
    // is dead data. OMap emits values (2, 3, 5) on many symbols where OCD
    // omits it (e.g. butlers-bush 309 / 416 / 532). Drop it when there are
    // no mid-symbol elements.
    drop.add('minimumMidSymbolCount')
  }
  return drop
}

const EMPTY_DROP: ReadonlySet<string> = new Set()

// Canonicalise a stroke's `dash` sub-object. The two readers emit the same
// dash pattern with different vocabularies:
//   OCD  {mainLength, mainGap, secGap, endLength, endGap}
//   OMap {dashLength, breakLength, dashesInGroup, inGroupBreakLength}
// Both reduce to `{dashLength, breakLength, [dashesInGroup>1], [inGroupBreakLength]}`.
//
// OCD decoding follows three cases, discriminated by `mainGap` and `secGap`:
//   - `mainGap` set  → 2-dash group. `mainLength = 2·dashLength + inGroupBreakLength`
//     so `dashLength = (mainLength - secGap) / 2`, `breakLength = mainGap`,
//     `inGroupBreakLength = secGap`. (E.g. 337 stairway: 337=2·150+37.)
//   - `mainGap` zero, `secGap` set → 1-dash groups back-to-back with `secGap`
//     between. `mainLength = dashLength + secGap` so `dashLength = mainLength - secGap`,
//     `breakLength = secGap`. (E.g. 106 ruined earth wall: 200 = 165 + 35.)
//   - `secGap` zero → plain repeat, `dashLength = mainLength`, `breakLength = mainGap`.
//
// `endLength`/`endGap` mirror `mainLength`/`secGap` (OCD-only redundancy for
// terminal dashes) and are dropped by `strokeCanonicalDrops`. OMap's
// `inGroupBreakLength` is emitted even when `dashesInGroup=1` — dead data
// in that case, dropped.
export function canonicaliseDash(dash: unknown): unknown {
  if (!dash || typeof dash !== 'object') return dash
  const source = dash as Record<string, unknown>
  const num = (k: string): number | undefined => {
    const v = source[k]
    return typeof v === 'number' ? v : undefined
  }
  const mainLength = num('mainLength')
  if (mainLength !== undefined) {
    const mainGap = num('mainGap') ?? 0
    const secGap = num('secGap') ?? 0
    if (secGap > 0 && mainGap > 0) {
      return {
        dashLength: (mainLength - secGap) / 2,
        breakLength: mainGap,
        dashesInGroup: 2,
        inGroupBreakLength: secGap,
      }
    }
    if (secGap > 0) {
      return { dashLength: mainLength - secGap, breakLength: secGap }
    }
    return { dashLength: mainLength, breakLength: mainGap }
  }
  const output: Record<string, unknown> = {}
  const dashesInGroup = num('dashesInGroup') ?? 1
  for (const [k, v] of Object.entries(source)) {
    if (k === 'inGroupBreakLength' && dashesInGroup <= 1) continue
    if (k === 'dashesInGroup' && v === 1) continue
    output[k] = v
  }
  return output
}

// Nested `text.text.*` keys to drop when they equal their default. The OCD
// reader emits the full OCAD text-symbol block (`wordSpace: 100`,
// `verticalAlignment: 0`, `indentFirst: 0`, `indentOther: 0`) verbatim; the
// OMap reader omits any field the mapper hasn't touched. Dropping the OCD
// defaults reconciles them without touching semantic values (`alignment`,
// `lineSpace`, etc. flow through untouched).
// Snap a mm font size to OCAD's storage grid (whole tenths of point). OCAD
// files store fontSize as `rawTenthsOfPoint` (integer); the reader converts
// with `× 25.4 / 720`. OMap stores mm directly, so the same visual "6pt"
// symbol can end up as 2.046 (OCD) vs 2.063 (OMap file, if Mapper stored
// 5.85 pt). Snap both to the coarser tenths-of-pt integer grid so they
// coincide — 1/72 in ≈ 0.35 mm at 1pt, so <0.05mm difference isn't
// visible on paper maps.
function snapFontSizeMm(mm: number): number {
  const tenthsOfPt = Math.round((mm * 720) / 25.4)
  return Number(((tenthsOfPt * 25.4) / 720).toFixed(3))
}

export function canonicaliseTextBody(text: unknown): unknown {
  if (!text || typeof text !== 'object') return text
  const source = text as Record<string, unknown>
  const output: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(source)) {
    if (key === 'wordSpace' && value === 100) continue
    if (key === 'verticalAlignment' && value === 0) continue
    if (key === 'indentFirst' && value === 0) continue
    if (key === 'indentOther' && value === 0) continue
    if (key === 'fontSize' && typeof value === 'number') {
      output[key] = snapFontSizeMm(value)
      continue
    }
    // OMap stores horizontal text alignment on the OBJECT (`hAlign`), not on
    // the text symbol; OCD emits `alignment` on the symbol here as its
    // default. Drop it — either it's the neutral 0 (left/none, OMap's
    // implicit default) or it's non-zero and redundant with per-object
    // hAlign that the OMap side reads. Symbol-level alignment doesn't
    // survive the OMap-native round-trip anyway.
    if (key === 'alignment') continue
    // `lineSpace` between the two readers uses different arithmetic (OCAD
    // stores a percent-of-fontsize, OMap stores a Qt-based mm-ish value)
    // and no single conversion recovers both — 916 8pt shows OCD 1.2 vs
    // OMap 1.044 for the same visual spacing. Drop it: the OCD writer's
    // symbol-body reads it back from the primary `text` block with a
    // sensible default when absent.
    if (key === 'lineSpace') continue
    output[key] = value
  }
  return output
}

// Keys that hold color-id references anywhere in the symbol tree.
const COLOR_ID_KEYS = new Set([
  'color',
  'colorId',
  'innerColor',
  'outerColor',
  'fillColor',
  'leftColor',
  'rightColor',
  'hatchColor',
])

export function remapColors(
  node: unknown,
  colorIds: Map<string | number, string>,
): unknown {
  if (Array.isArray(node)) {
    return node.map(child => remapColors(child, colorIds))
  }
  if (!node || typeof node !== 'object') return node
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (
      COLOR_ID_KEYS.has(k) &&
      (typeof v === 'number' || typeof v === 'string')
    ) {
      out[k] = colorIds.get(v as string | number) ?? v
    } else {
      out[k] = remapColors(v, colorIds)
    }
  }
  return out
}

// A stroke casing line. Mirrors the layer rename: the source's bare `color`
// becomes the canonical `colorId`.
export function borderToGitmap(
  border: unknown,
  colorIds: Map<string | number, string>,
): unknown {
  if (!border || typeof border !== 'object') return border
  const output: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(
    border as Record<string, unknown>,
  )) {
    if (value === undefined) continue
    if (key === 'color') {
      output.colorId = colorIds.get(value as string | number) ?? value
      continue
    }
    output[key] = value
  }
  return output
}

export function elementToGitmap(
  colorIds: Map<string | number, string>,
  element: Record<string, unknown>,
) {
  const output: Record<string, unknown> = {}
  Object.entries(element).forEach(([key, value]) => {
    if (value === undefined) return
    // `numberCoords` is a derived count (= coordinates.length); the canonical
    // form omits derived counts. The reader restores it from the array.
    if (key === 'numberCoords') return
    if (key === 'color') {
      // Canonical colour reference is `colorId` everywhere.
      output.colorId = colorIds.get(value as string | number) || value
      return
    }
    if (key === 'coords') {
      // Icon-primitive geometry uses the same tuple form AND the same field
      // name as object `coordinates` (see elementCoordToJson).
      output.coordinates = (value as unknown[]).map(elementCoordToJson)
      return
    }
    if (key === 'diameter') {
      // Canonical circular size is `radius`, matching point-fill/point-stroke;
      // OCAD icon primitives store diameter, so halve it here.
      output.radius = (value as number) / 2
      return
    }
    // XMap-style element.symbol carries a full nested symbol tree
    // (areaSymbol / lineSymbol / pointSymbol) with its own color
    // references — recurse via remapColors, not toJsonSafe, so those
    // integer ids get lifted to the Panmap string ids.
    output[key] = remapColors(toJsonSafe(value), colorIds)
  })
  return output
}

export function coordinatesToJson(coordinates: unknown[]): unknown[] {
  return coordinates.map(coord => coordToJson(coord))
}

// Split flat model coordinates into explicit rings. A multi-ring area marks its
// ring boundaries with the hole bit (yFlags 0x02) on the LAST coord of each ring
// that a hole follows (Mapper's isHolePoint). Emit the first ring as the outer
// boundary and the rest as `holes`; the boundary is now structural, so the
// `hole` flag is not written on any tuple. A single-ring object (line, simple
// area, point, text) yields just `coordinates` with no `holes`.
export function ringsToJson(coordinates: unknown[]): {
  coordinates: unknown[]
  holes?: unknown[][]
} {
  const rings: unknown[][] = [[]]
  coordinates.forEach((coord, i) => {
    rings[rings.length - 1].push(coord)
    const yF = (coord as { yFlags?: number }).yFlags ?? 0
    if (yF & 0x02 && i < coordinates.length - 1) rings.push([])
  })
  const [outer, ...inner] = rings
  const out: { coordinates: unknown[]; holes?: unknown[][] } = {
    coordinates: coordinatesToJson(outer),
  }
  if (inner.length) out.holes = inner.map(ring => coordinatesToJson(ring))
  return out
}

// Element (icon primitive) coord as a compact tuple `[x, y]` / `[x, y, flags]`,
// the same shape as object coords. Unlike an object, an icon primitive is a
// single shape that isn't ring-split, so `hole` stays a valid semantic flag here
// (an icon area primitive can carry a hole boundary). Element coords are
// symbol-internal (y-up), so they are never Y-flipped.
function elementCoordToJson(coord: unknown): unknown {
  const src = coord as {
    0?: number
    1?: number
    x?: number
    y?: number
    xFlags?: number
    yFlags?: number
  }
  const isTuple = Array.isArray(coord)
  const x = cleanNumber(isTuple ? src[0] : src.x)
  const y = cleanNumber(isTuple ? src[1] : src.y)
  const flags = semanticCoordFlags(src.xFlags ?? 0, src.yFlags ?? 0, true)
  return flags ? [x, y, flags] : [x, y]
}

/**
 * Serialise a coordinate as a compact tuple.
 *
 * Plain vertex: `[x, y]`. A vertex carrying path flags: `[x, y, flags]`, where
 * `flags` is an object of SEMANTIC boolean keys — `control` (a Bézier control
 * point), `corner`, `dash`. Hole-ring boundaries are structural (see
 * `ringsToJson`), not a coord flag. The OCAD-shaped xFlags/yFlags bytes are
 * translated to these on write and back on read; the raw OMap byte is not stored.
 */
function coordToJson(coord: unknown): unknown {
  const src = coord as {
    0?: number
    1?: number
    x?: number
    y?: number
    xFlags?: number
    yFlags?: number
  }
  const isTuple = Array.isArray(coord)
  const x = cleanNumber(isTuple ? src[0] : src.x)
  const y = cleanNumber(isTuple ? src[1] : src.y)
  const flags = semanticCoordFlags(src.xFlags ?? 0, src.yFlags ?? 0)
  return flags ? [x, y, flags] : [x, y]
}

// OCAD flag bytes → semantic flags. xFlags 0x01/0x02 are the two Bézier control
// points (both -> `control`; cp1 vs cp2 is recovered by position on read).
// yFlags: 0x01 corner, 0x02 hole, 0x08 dash point. Object coords pass
// `includeHole = false` — their hole rings are structural (outer `coordinates` +
// `holes`); element (icon) coords pass `true`, since a primitive isn't ring-split.
function semanticCoordFlags(
  xF: number,
  yF: number,
  includeHole = false,
): Record<string, true> | undefined {
  const f: Record<string, true> = {}
  if (xF & 0x03) f.control = true
  if (yF & 0x01) f.corner = true
  if (includeHole && yF & 0x02) f.hole = true
  if (yF & 0x08) f.dash = true
  return Object.keys(f).length ? f : undefined
}

export function toJsonSafe(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toJsonSafe)
  // Round scalars to the shared 3-dp grid (as coordinates are). The two readers
  // reach render-layer sizes/angles by different arithmetic — OCAD from integer
  // tenths, OMap from radians/µm — so the same value lands as `90` vs
  // `90.0002…` or `1.058` vs `1.0583333…`. Rounding makes them serialise
  // identically; integers pass through untouched.
  if (typeof value === 'number') {
    return Number.isInteger(value) ? value : Number(value.toFixed(3))
  }
  if (!value || typeof value !== 'object') return value

  const output: Record<string, unknown> = {}
  Object.entries(value as Record<string, unknown>).forEach(([key, child]) => {
    if (child === undefined || typeof child === 'function') return
    output[key] = toJsonSafe(child)
  })
  return output
}
