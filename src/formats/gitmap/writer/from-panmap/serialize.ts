import type { RenderLayer } from '../../../../panmap/model.js'
import { cleanNumber } from '../../../../util/number.js'

// Fields to drop when canonicalising a `stroke` render layer, so an OCD- and an
// OMap-sourced copy of the same line serialise identically. The OCAD reader
// emits `lineStyle` (a packed cap+join byte that `capStyle`/`joinStyle` already
// carry, and that the SVG renderer ignores) and gates zero offsets to
// undefined; the OMap reader omits `lineStyle` but always emits the zero
// defaults. Dropping `lineStyle` + the defaults reconciles both. Non-default
// values are kept (a stroke that genuinely offsets or hides its mid-symbol).
export function strokeCanonicalDrops(
  layer: RenderLayer,
  siblingLayers: RenderLayer[] = [],
): ReadonlySet<string> {
  if ((layer as { type?: string }).type !== 'stroke') return EMPTY_DROP
  const l = layer as Record<string, unknown>
  const drop = new Set<string>(['lineStyle'])
  // `minimumMidSymbolCount` has no OCAD representation at all — no reader
  // populates it and no writer emits it, so it can only ever arrive from an
  // xmap. A single-format field can't live in the canonical model, so drop
  // it outright rather than only when mid-symbols are absent (OMap emits 2
  // on symbols like 309 / 416 where the OCD sibling has nothing).
  drop.add('minimumMidSymbolCount')
  // 0 and absent both mean "no mid-symbol offset"; OCD reaches us with the
  // field missing where OMap writes an explicit 0. Drop whenever falsy so
  // the two agree regardless of whether mid-symbols are present.
  if (!l.midSymbolDistance) drop.add('midSymbolDistance')
  // 1 is Mapper's default "one symbol per spot" and is what it writes on
  // every line symbol. The OCD side reaches us with the field absent even
  // where mid-symbol elements exist, so the explicit 1 is the odd one out.
  // Dropping it agrees with the OCD source rather than overriding it.
  if (l.midSymbolsPerSpot === 1) drop.add('midSymbolsPerSpot')
  if (l.showAtLeastOneSymbol === true || l.showAtLeastOneSymbol === undefined) {
    drop.add('showAtLeastOneSymbol')
  }
  if (!l.startOffset) drop.add('startOffset')
  if (!l.endOffset) drop.add('endOffset')
  // Mid-symbol placement fields (`segmentLength` / `midSymbolsPerSpot` /
  // `midSymbolDistance`) only matter when the SYMBOL actually has mid-symbol
  // elements. They may live on a sibling `line-elements` layer rather than
  // on the stroke itself (OMap sourcing splits stroke geometry from
  // mid-symbol elements into two layers). Check siblings too so 104
  // Earth bank keeps its `segmentLength=50` / `endLength=57` through the
  // gitmap round-trip, giving the OCD writer the mid-tag spacing it needs.
  const strokeHasMidSymbols =
    Array.isArray(l.primSymElements) &&
    (l.primSymElements as unknown[]).length > 0
  const siblingHasMidDecor = siblingLayers.some(sib => {
    if ((sib as { type?: string }).type !== 'line-elements') return false
    const s = sib as Record<string, unknown>
    for (const key of [
      'primSymElements',
      'startSymElements',
      'endSymElements',
      'cornerSymElements',
    ]) {
      if (Array.isArray(s[key]) && (s[key] as unknown[]).length > 0) return true
    }
    return false
  })
  const hasMidSymbols = strokeHasMidSymbols || siblingHasMidDecor
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
  // Dashed lines hide any bevel/miter distinction under the dash breaks;
  // Mapper's OCAD export commonly forces `lineStyle=0` (flat cap + bevel
  // join, byte 0) for dashed lines even when the xmap source specified
  // miter, which causes an unresolvable OCD ↔ xmap divergence on lines
  // like 103 Form line (xmap `join_style="0"` miter vs OCD lineStyle=0
  // bevel). Drop joinStyle when non-round on any dashed stroke so both
  // dialects agree; round joins are visually distinct at dash tips and
  // stay preserved.
  const strokeDash = l.dash as
    | { mainLength?: number; mainGap?: number; secGap?: number }
    | undefined
  if (strokeDash && l.joinStyle !== 2) drop.add('joinStyle')
  // `segmentLength: 0` is Mapper's explicit "no mid-symbol spacing" that
  // the OCD reader represents as an OMITTED field (mainLength=0 →
  // segmentLength=undefined). Drop the explicit 0 so both dialects agree
  // on absence (hillmorton 510/511 Power line: cornerSymElements-only
  // lines where mid-spacing is meaningless).
  if (l.segmentLength === 0) drop.add('segmentLength')
  // `segmentLength: 400` is Mapper's UI default for mid-symbol placement
  // cycle (xmap `segment_length="4000"`). Mapper's own OCAD export
  // discards this default rather than encoding it as `mainLength=400`,
  // so OCD-sourced side has no segmentLength. Drop when the source
  // reached us with the default to keep both dialects converged
  // (hillmorton 532 Stairway, butlers 106 Ruined earth wall on the xmap
  // side).
  if (l.segmentLength === 400) drop.add('segmentLength')
  // On an invisible stroke (colorId=-1) the `width` field is a hidden
  // carrier value used by Mapper to shape borders/mid-symbols; OCD
  // stores 0, xmap sometimes carries a non-zero "ghost" value. Both
  // mean "no visible stroke" — drop when invisible so they converge.
  if (l.colorId === -1) drop.add('width')
  if (!hasMidSymbols) {
    drop.add('segmentLength')
    // No mid-symbol geometry → the count is dead data whatever its value (OCD
    // omits it; OMap may emit 0 or 1). Drop it unconditionally.
    drop.add('midSymbolsPerSpot')
  }
  return drop
}

const EMPTY_DROP: ReadonlySet<string> = new Set()

// Canonicalise a stroke's `dash` sub-object. The canonical model uses
// Mapper's semantic vocab (`dashLength`, `breakLength`, `dashesInGroup`,
// `inGroupBreakLength`, `halfOuterDashes`) on BOTH readers — see
// `formats/ocad/reader/to-panmap.ts:dashFromOcd` for the OCD-side
// translation. This function only drops fields that are dead data
// (`inGroupBreakLength` when only 1 dash per group; `dashesInGroup: 1`
// as the default).
export function canonicaliseDash(dash: unknown): unknown {
  if (!dash || typeof dash !== 'object') return dash
  const source = dash as Record<string, unknown>
  const output: Record<string, unknown> = {}
  const dashesInGroup =
    typeof source.dashesInGroup === 'number' ? source.dashesInGroup : 1
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
//
// OCAD's corner (0x01) and dash (0x08) both collapse to one `dash` — Mapper
// has a single marked-vertex flag (DashPoint) covering both
// (`ocd_file_import.cpp`: `if ((y & FlagDash) || (y & FlagCorner))
// setDashPoint(true)`), so the distinction is not expressible in every
// source format and cannot live in the canonical model. Corroborated on the
// corpus: xmap DashPoint counts equal OCAD corner + dash exactly, per map
// (e.g. woodend 1470 = 860 + 610). `dash` is Mapper's name for it, matching
// the rest of the v2 dash vocabulary.
//
// The collapse is NOT lossy: which byte to write back is re-derived from the
// symbol on export (see `markedVertexFlag` in the OCD writer, which mirrors
// Mapper's `ocd_file_export.cpp`). Round-tripping bottle-lake reproduces the
// source split exactly — corner=2309 dash=1687 in, corner=2309 dash=1687 out.
function semanticCoordFlags(
  xF: number,
  yF: number,
  includeHole = false,
): Record<string, true> | undefined {
  const f: Record<string, true> = {}
  if (xF & 0x03) f.control = true
  if (includeHole && yF & 0x02) f.hole = true
  if (yF & 0x09) f.dash = true
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
