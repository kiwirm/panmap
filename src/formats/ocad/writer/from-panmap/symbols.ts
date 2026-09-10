import type { MapColor, MapSymbol } from '../../../../map/model.js'
import { classifyAreaLayers , isPatternLayer } from '../../../../map/render-layers.js'
import { parseSymbolCode } from '../../../../util/symbol-code.js'
import { colorNumberLookup } from '../../../../util/color.js'
import { strokeColorValid } from '../../../../util/stroke-classifier.js'
import { collectSymbolColors } from '../../../../util/collect-symbol-colors.js'
import {
  PointSymbolType,
  LineSymbolType,
  AreaSymbolType,
  TextSymbolType,
} from '../../native/symbol-types.js'
import { synthesizeIconBits } from './icon.js'
import { pointBody } from './symbol-bodies/point.js'
import { lineBody } from './symbol-bodies/line.js'
import { areaBody } from './symbol-bodies/area.js'
import { textBody } from './symbol-bodies/text.js'

/**
 * Convert a `MapSymbol` into the OCAD Symbol11-family shape
 * that `writeSymbol` (write/encode-symbol.ts) consumes.
 *
 * This is the from-scratch path used when the source map isn't OCAD.
 * The output isn't byte-identical to what OCAD would write for the
 * same map (Mapper synthesizes some fields differently — e.g. icon
 * bits are rasterized, not zero), but it re-parses cleanly with
 * panmap's OCAD reader and renders identically in Mapper.
 *
 * Notable defaults:
 *   - `iconBits` (484 B) — zeros. Symbol palette icons will render
 *     blank in OCAD/Mapper's toolbox; rasterization is a follow-up.
 *   - `symbolTreeGroup` (64 words) — zeros. OCAD uses this for its
 *     symbol tree UI hierarchy; empty is fine and shows a flat list.
 *   - `mystery64` (64 B) — zeros. This block has never been reversed;
 *     zeros match what Mapper writes for new files.
 */
/**
 * Intermediate OCAD symbol record produced by `synthesizeSymbol`.
 * The full field surface is large (~30 fields from `commonHeader` +
 * per-type body + extent), so callers see it as a permissive
 * record. The two fields callers actually reach into (`colors`
 * palette + `nColors` count) are typed explicitly so cast-free
 * mutation is safe.
 */
export interface SynthesizedOcadSymbol {
  colors: number[]
  nColors: number
  extent: number
  [key: string]: unknown
}

export function synthesizeSymbols(
  symbols: MapSymbol[],
  colors: MapColor[],
  sourceFormat?: string,
  symNums?: Map<MapSymbol['id'], number>,
): SynthesizedOcadSymbol[] {
  const colorNumber = colorNumberLookup(colors)
  // OCAD uses Y-up (north = positive Y). Xmap / gitmap sources store
  // paper Y-down; flip on the way out. OCAD-sourced maps arrive Y-up
  // already — but the sidecar preserving that has been removed, so the
  // sourceFormat check remains as the sole signal.
  const flipY = sourceFormat !== 'ocad'
  const out: SynthesizedOcadSymbol[] = []
  const symNumFor = (s: MapSymbol): number =>
    symNums?.get(s.id)
    ?? parseSymbolCode(s.code || String(s.sourceId ?? s.id))
  // Areas with a `stroke` render layer are drawn in OCAD as an area
  // symbol whose `borderSym` points at a paired line symbol. Mapper
  // synthesises the paired line symbol on export (see 301.0 →
  // borderSym=301004). We do the same: allocate a synthetic symNum
  // for the border, emit a matching line symbol, and hand the id
  // back to `synthesizeSymbol` so the area body can reference it.
  // Reserve a synthetic symNum range for border helpers, but skip
  // any values that collide with a Panmap symbol's synNum (e.g.
  // hillmorton's "Text 36 pt" symbol has code "900" → 900000, which
  // would clash with our old default border base of 900000).
  const usedSymNums = new Set(symbols.map(symNumFor))
  const borderRegistry = new Map<MapSymbol, number>()
  let borderCounter = 990000
  const nextBorderNum = () => {
    while (usedSymNums.has(borderCounter)) borderCounter++
    const n = borderCounter++
    usedSymNums.add(n)
    return n
  }
  // Track areas that already reference an existing border line symbol
  // (via a `border-symbol` render layer from the ocd→xmap→ocd path).
  // For those we reuse the referenced symNum directly instead of
  // allocating a synthetic 99xxxx border helper — the border already
  // exists as a first-class map symbol.
  const existingBorderRef = new Map<MapSymbol, number>()
  for (const symbol of symbols) {
    if (symbol.type !== 'area' && symbol.type !== 'combined') continue
    const { border: borderLayer, strokes } = classifyAreaLayers(symbol)
    if (borderLayer) {
      const refId = borderLayer.symbolId
      const referenced = symbols.find(s => s.id === refId || s.sourceId === refId)
      if (referenced) {
        const referencedNum = symNumFor(referenced)
        if (referencedNum) {
          existingBorderRef.set(symbol, referencedNum)
          continue
        }
      }
    }
    const stroke = strokes[0]
    if (!stroke) continue
    if (!strokeColorValid(stroke)) continue
    // A `combined` symbol whose layers infer to a LINE (a stroke with no fill)
    // is written by `synthesizeSymbol` as an OCAD line that folds its casing
    // into its own `doubleLine` fields — it never references a border symNum.
    // Allocating one here just emits an orphan 990.x border line that nothing
    // uses and inflates the symbol count. Skip it.
    if (inferOcadTypeFromLayers(symbol) === 'line') continue
    borderRegistry.set(symbol, nextBorderNum())
  }
  for (const symbol of symbols) {
    const borderSymNum = borderRegistry.get(symbol) ?? existingBorderRef.get(symbol)
    const s = synthesizeSymbol(symbol, colorNumber, colors, flipY, borderSymNum, symNumFor(symbol))
    if (s) {
      // Merge the border line's colors into the area's colorSet so
      // Mapper's rendering + palette count agree with what it writes
      // when it exports the same source. Applies to both synthesised
      // (borderRegistry) and existing (existingBorderRef) borders.
      const refSymbol = borderRegistry.has(symbol)
        ? symbol // synthesised — copy from source area's stroke
        : (() => {
            const refId = classifyAreaLayers(symbol).border?.symbolId
            return symbols.find(x => x.id === refId || x.sourceId === refId)
          })()
      if (refSymbol) {
        const extra = collectSymbolColors(refSymbol, colorNumber)
        const merged = new Set<number>(s.colors)
        for (const c of extra) merged.add(c)
        const sorted = [...merged].sort((a, b) => a - b).slice(0, 14)
        s.colors = sorted
        s.nColors = sorted.length
      }
      out.push(s)
    }
    // Only synthesise a paired border line when we allocated a new
    // synthetic id; existing references already resolve to a real
    // symbol emitted elsewhere in this loop.
    if (borderRegistry.has(symbol)) {
      const border = synthesizeBorderLine(symbol, colorNumber, colors, borderRegistry.get(symbol)!)
      if (border) out.push(border)
    }
  }
  return out
}

/**
 * Build a line-symbol record from an area's `stroke` render layer.
 * The returned record shape matches what `writeSymbol` writes for
 * a plain line. Used as the paired `borderSym` for area symbols.
 */
function synthesizeBorderLine(
  areaSymbol: MapSymbol,
  colorNumber: (id: unknown) => number,
  colors: MapColor[],
  symNum: number,
): SynthesizedOcadSymbol | null {
  const stroke = classifyAreaLayers(areaSymbol).strokes[0]
  if (!stroke) return null
  // Fake a minimal MapSymbol so the existing lineBody/commonHeader
  // helpers work — the stroke layer alone is all we need.
  const fake: MapSymbol = {
    id: symNum,
    sourceId: symNum,
    code: `${Math.floor(symNum / 1000)}.${symNum % 1000}`,
    name: (areaSymbol.name ?? '') + ' — border',
    type: 'line',
    hidden: false,
    renderLayers: [stroke],
  }
  return synthesizeSymbol(fake, colorNumber, colors, false, undefined, /* forcedSymNum */ symNum)
}

function synthesizeSymbol(
  symbol: MapSymbol,
  colorNumber: (id: unknown) => number,
  colors: MapColor[],
  flipY: boolean,
  borderSymNum?: number,
  forcedSymNum?: number,
): SynthesizedOcadSymbol | null {
  const symNum = forcedSymNum
    ?? parseSymbolCode(symbol.code || String(symbol.sourceId ?? symbol.id))
  // xmap's Panmap converter flattens `combined` symbols' component
  // renderLayers into a single symbol; the composite type in OCAD is
  // whichever primitive geometry the layers describe. Infer that from
  // the flattened layer types.
  const effectiveType = symbol.type === 'combined'
    ? inferOcadTypeFromLayers(symbol)
    : symbol.type

  // Compute type-body first so we can hand the resulting point
  // elements to the icon rasterizer, giving it real geometry to
  // draw instead of a stylised disc.
  let body: Record<string, unknown> | null = null
  switch (effectiveType) {
    case 'point': body = pointBody(symbol, colorNumber, flipY); break
    case 'line':  body = lineBody(symbol, colorNumber, flipY); break
    case 'area':  body = areaBody(symbol, colorNumber, flipY, borderSymNum); break
    case 'text':  body = textBody(symbol, colorNumber); break
    default: return null
  }

  const pointElements = effectiveType === 'point'
    ? (body.elements as Array<{ type: number; color: number; lineWidth: number; diameter: number; coords: Array<{ 0: number; 1: number }> }>)
    : undefined

  const extent = computeExtent(effectiveType, body, pointElements)

  const common = commonHeader(
    symbol, colorNumber, symNum, effectiveType, colors,
    pointElements,
  )
  if (pointElements) {
    const set = new Set<number>(common.colors)
    for (const el of pointElements) {
      if (el.color != null && el.color >= 0) set.add(el.color)
    }
    common.colors = [...set].sort((a, b) => a - b).slice(0, 14)
    common.nColors = common.colors.length
  }
  return { ...common, extent, ...body } as SynthesizedOcadSymbol
}

/**
 * OCAD's `extent` field is the symbol's bounding radius in map units
 * (0.01 mm). Mapper uses it for spatial indexing when rendering; a
 * zero extent tells Mapper the symbol occupies zero area, so nothing
 * gets drawn even though the symbol and its colors are otherwise
 * valid. Per real Mapper output (see test fixtures):
 *   - line symbols: half the stroke width
 *   - point symbols: the largest element half-extent
 *   - area / text: 0 (Mapper computes from geometry directly)
 */
function computeExtent(
  effectiveType: string,
  body: Record<string, unknown>,
  pointElements?: Array<{ lineWidth: number; diameter: number; coords: Array<{ 0: number; 1: number }> }>,
): number {
  if (effectiveType === 'line') {
    // Mapper's `exportLineSymbolPrivate` builds extent as:
    //   extent = lineWidth / 2
    //   for each border: extent = max(extent, dblWidth/2 + border.shift + border.width/2)
    //   extent = max(extent, extentOf(midSym / startSym / endSym / dashSym))
    // Take half the widest element in each decoration list. Coord
    // arrays on decoration elements are relative to the anchor, so
    // their extent is half-max(|x|,|y|) + halfWidth.
    const lineWidth = Number(body.lineWidth) || 0
    const dbl = body.doubleLine as {
      dblLeftWidth?: number; dblRightWidth?: number; dblWidth?: number
    } | undefined
    let extent = lineWidth / 2
    if (dbl) {
      const halfDbl = (dbl.dblWidth ?? 0) / 2
        + Math.max(dbl.dblLeftWidth ?? 0, dbl.dblRightWidth ?? 0)
      if (halfDbl > extent) extent = halfDbl
    }
    for (const key of ['primSymElements', 'startSymElements', 'endSymElements', 'cornerSymElements']) {
      const arr = body[key] as Array<{
        lineWidth?: number; diameter?: number;
        coords?: Array<{ 0: number; 1: number }>
      }> | undefined
      if (!arr?.length) continue
      for (const el of arr) {
        const halfW = Math.max((el.diameter ?? 0) / 2, (el.lineWidth ?? 0) / 2)
        for (const c of (el.coords ?? [])) {
          const d = Math.max(Math.abs(c[0]), Math.abs(c[1])) + halfW
          if (d > extent) extent = d
        }
      }
    }
    return Math.max(0, Math.round(extent))
  }
  if (effectiveType === 'point' && pointElements?.length) {
    // Mapper's `getPointSymbolExtent`: half the max dimension of the
    // full bounding box across all element coords + their radius / line
    // width. NOT the Euclidean distance from origin (which our old
    // impl used and consistently over-counted, e.g. sym 601005
    // arrowhead computed 612 instead of Mapper's 306).
    let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity
    for (const el of pointElements) {
      const halfW = Math.max(el.diameter / 2, el.lineWidth / 2)
      for (const c of el.coords) {
        if (c[0] - halfW < minX) minX = c[0] - halfW
        if (c[0] + halfW > maxX) maxX = c[0] + halfW
        if (c[1] - halfW < minY) minY = c[1] - halfW
        if (c[1] + halfW > maxY) maxY = c[1] + halfW
      }
    }
    if (!Number.isFinite(minX)) return 0
    const maxDim = Math.max(maxX - minX, maxY - minY)
    return Math.max(1, Math.round(maxDim / 2))
  }
  return 0
}

/**
 * Pick the OCAD symbol type for a Panmap symbol whose declared
 * type is `combined`. Preference order matches how Mapper's UI treats
 * these: fill / hatch means area (line is auxiliary border), then
 * stroke means line, then point primitives, then text.
 */
function inferOcadTypeFromLayers(symbol: MapSymbol): string {
  const types = new Set((symbol.renderLayers ?? []).map(l => l.type))
  if (types.has('fill') || types.has('hatch-fill') || types.has('point-pattern-fill')) {
    return 'area'
  }
  if (types.has('stroke') || types.has('line-symbols')) return 'line'
  if (
    types.has('point-fill')
    || types.has('point-stroke')
    || types.has('point-elements')
  ) return 'point'
  if (types.has('text')) return 'text'
  return 'point'
}

function commonHeader(
  symbol: MapSymbol,
  colorNumber: (id: unknown) => number,
  symNum: number,
  effectiveType: string,
  colors: MapColor[],
  pointElements?: Array<{
    type: number; color: number; lineWidth: number; diameter: number;
    coords: Array<{ 0: number; 1: number }>
  }>,
) {
  const type = ocadType(effectiveType)
  const colorSet = collectSymbolColors(symbol, colorNumber)
  // xmap's `rotatable="true"` on a point/text symbol maps to OCAD's
  // symbol flag bit 0 — Mapper writes flags=1 for these. Line and
  // area symbols don't carry a rotatable bit in xmap; leave 0.
  const rotatable = isRotatable(symbol)
  const flags = rotatable ? 1 : 0
  return {
    size: 0, // patched by writer after encoding
    symNum,
    otp: otpForType(effectiveType),
    flags,
    selected: false,
    status: symbol.hidden ? 2 : 0, // 2 = hidden in OCAD
    preferredDrawingTool: 0,
    csMode: 0,
    csObjType: 0,
    csCdFlags: 0,
    extent: 0,
    nColors: colorSet.length,
    colors: colorSet,
    description: symbol.name ?? '',
    descriptionWords: undefined as number[] | undefined,
    // iconBits, symbolTreeGroup, and mystery64 are OCAD-only blobs.
    // Without a source sidecar, iconBits are synthesized (blank in
    // Mapper's palette until it re-rasterises on open) and the others
    // stay empty. See the "best-effort" note in the README.
    iconBits: synthesizeIconBits(symbol, effectiveType, colors, pointElements),
    symbolTreeGroup: [] as number[],
    mystery64: undefined as Uint8Array | undefined,
    _tail: undefined as Uint8Array | undefined,
    type,
  }
}

/**
 * Detect whether a Panmap symbol is rotatable. xmap stores this
 * flag on point/text sub-symbols; here we look for it on any layer
 * that carries a `pointSymbol` or `textSymbol` payload. Text-symbol
 * rotatable state comes from `symbol.textSymbol.rotatable`.
 */
function isRotatable(symbol: MapSymbol): boolean {
  // Both readers (ocad + xmap) now surface a top-level `rotatable` on
  // the MapSymbol; prefer that. The layer walks below are
  // kept as a fallback for gitmap-sourced maps that predate the flag
  // or hand-built symbols that only set it on a nested pattern.
  if (symbol.rotatable) return true
  if (symbol.textSymbol?.rotatable) return true
  for (const layer of symbol.renderLayers ?? []) {
    if (layer.rotatable) return true
    if (isPatternLayer(layer) && layer.pattern?.rotatable) return true
    for (const key of ['pointSymbol', 'symbol'] as const) {
      const inner = (layer as Record<string, unknown>)[key] as
        | { rotatable?: boolean } | undefined
      if (inner?.rotatable) return true
    }
  }
  return false
}

function ocadType(t: string): number {
  switch (t) {
    case 'point': return PointSymbolType
    case 'line':  return LineSymbolType
    case 'area':  return AreaSymbolType
    case 'text':  return TextSymbolType
    default:      return PointSymbolType
  }
}

/**
 * Object Type Primitive — how OCAD categorises the geometry the symbol
 * can be applied to. Values from Mapper's `ocd_types.h`.
 */
function otpForType(t: string): number {
  switch (t) {
    case 'point': return 1
    case 'line':  return 2
    case 'area':  return 3
    case 'text':  return 4
    default:      return 1
  }
}

