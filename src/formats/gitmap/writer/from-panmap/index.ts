import type {
  MapColor,
  MapObject,
  MapSymbol,
  RenderLayer,
} from '../../../../panmap/model.js'
import {
  capStyleToGitmap,
  joinStyleToGitmap,
  hAlignToGitmap,
  vAlignToGitmap,
  rotationToGitmap,
} from '../../codecs/index.js'
import { canonicalSymbolCode } from '../../../../panmap/symbol-code.js'
import { stableColorId, stableSymbolId } from './ids.js'
import {
  canonicalSymbolType,
  canonicalisePointElementsLayer,
  doubleLineToStroke,
  canonicaliseFrameStroke,
  stripPhantomBorders,
  canonicaliseBorderShift,
  canonicaliseStrokeWidth,
  canonicalisePointRadius,
  dereferenceBorderSymbol,
  stripLineElementsRedundancy,
  canonicalLayerOrder,
  mergePrimaryStrokeWithBorders,
  isPhantomStroke,
  isPhantomFillLayer,
} from './canonicalise.js'
import {
  ringsToJson,
  coordinatesToJson,
  toJsonSafe,
  strokeCanonicalDrops,
  canonicaliseDash,
  canonicaliseTextBody,
  remapColors,
  borderToGitmap,
  elementToGitmap,
} from './serialize.js'

function toGitmapColor(color: MapColor) {
  return {
    id: stableColorId(color),
    order: color.sourceId ?? color.id,
    name: color.name || '',
    // Screen colour as an integer [r, g, b] (0–255), matching cmyk's array shape.
    rgb: rgbToArray(color.rgb),
    // OCAD-side rendering uses CMYK, not RGB — persist it so a gitmap → ocd
    // round-trip preserves ink density. OCAD stores CMYK as whole percentages,
    // so snap to that grid (2 dp): an OCD-sourced colour is already quantised
    // while an OMap-sourced copy keeps half-percent values — snapping matches.
    cmyk: roundTuple(color.cmyk, 2),
    opacity: color.opacity,
    // Paint priority (higher = drawn on top). Distinct from `order` (palette
    // index): the two diverge in OCAD maps where list order ≠ draw order.
    renderOrder: color.renderOrder ?? 0,
  }
}

function roundTuple(tuple: unknown, dp: number): unknown {
  if (!Array.isArray(tuple)) return tuple
  const f = 10 ** dp
  return tuple.map(v => (typeof v === 'number' ? Math.round(v * f) / f : v))
}

// Normalise a model RGB (a CSS `rgb(r,g,b)` string, or an [r,g,b] array in 0–255
// or 0–1) to a canonical integer [r, g, b] triple (0–255).
function rgbToArray(rgb: unknown): [number, number, number] | undefined {
  if (typeof rgb === 'string') {
    const m = rgb.match(/-?\d+(?:\.\d+)?/g)
    if (!m || m.length < 3) return undefined
    return m.slice(0, 3).map(n => Math.round(Number(n))) as [
      number,
      number,
      number,
    ]
  }
  if (Array.isArray(rgb) && rgb.length >= 3) {
    const max = Math.max(rgb[0], rgb[1], rgb[2])
    const scale = max <= 1 ? 255 : 1
    return rgb.slice(0, 3).map(v => Math.round(Number(v) * scale)) as [
      number,
      number,
      number,
    ]
  }
  return undefined
}

// Layer lengths that OCAD can only hold as whole 0.01 mm units, so the
// canonical value is rounded to that grid (see the call site). Deliberately
// narrow: only fields observed to diverge by sub-unit amounts across the
// corpus, not every numeric — angles, ratios and opacities must not round.
const OCD_GRID_LENGTHS = new Set([
  'endOffset',
  'startOffset',
  'pointedCapLength',
  'height',
])

function toGitmapSymbol(
  symbol: MapSymbol,
  colorIds: Map<string | number, string>,
  symbolIds: Map<string | number, string> = new Map(),
  symbolsById: Map<string | number, MapSymbol> = new Map(),
) {
  const layers = symbol.layers || []
  // Only drop phantom strokes when the symbol also has a `double-line`
  // (or already-canonicalised `stroke.borders`): the phantom's sole job
  // is to mark "the primary is invisible; visible geometry lives in the
  // companion". Without that companion, a colorId=-1 stroke may be
  // load-bearing (e.g. cell placeholders).
  const hasDoubleLineCompanion = layers.some(l => {
    const t = (l as { type?: string }).type
    if (t === 'double-line') return true
    if (t !== 'stroke') return false
    const borders = (l as { borders?: unknown[] }).borders
    return Array.isArray(borders) && borders.length > 0
  })
  const canonLayers = mergePrimaryStrokeWithBorders(
    layers
      // `combined-refs` is an OMap-only sidecar the reader emits alongside
      // the flattened per-part layers so the direct xmap writer can re-emit
      // `<combined_symbol>`. Drop for gitmap so OCD-vs-OMap convergence
      // stays on the flattened form.
      .filter(layer => (layer as { type?: string }).type !== 'combined-refs')
      .filter(layer => !isPhantomFillLayer(layer))
      .filter(layer => !(hasDoubleLineCompanion && isPhantomStroke(layer)))
      .flatMap(canonicalisePointElementsLayer)
      .map(doubleLineToStroke)
      .map(canonicaliseFrameStroke)
      .map(stripPhantomBorders)
      .map(canonicaliseBorderShift)
      .map(canonicaliseStrokeWidth)
      .map(canonicalisePointRadius)
      .map(l => dereferenceBorderSymbol(l, symbolsById))
      .map(stripLineElementsRedundancy)
      .sort(canonicalLayerOrder),
  )
  return {
    id: stableSymbolId(symbol),
    code: canonicalSymbolCode(symbol.code) || undefined,
    name: symbol.name,
    // Derive type from CANONICAL layers, not raw — my transforms can
    // collapse `combined` into a plain `line` (e.g. via
    // `mergePrimaryStrokeWithBorders`), and gitmap should reflect that.
    type: canonicalSymbolType(symbol.type, canonLayers),
    // Omit boolean fields that equal their default so a semantic toggle
    // shows up in `git diff` as a real field add, not a value swap.
    hidden: symbol.hidden ? true : undefined,
    // `protected` is a canonical MapSymbol field derived by BOTH readers
    // (OCAD from status byte bit 0; OMap from `is_protected="true"`),
    // so it converges through gitmap. Emit only when true so the file
    // stays lean.
    protected: symbol.protected ? true : undefined,
    rotatable: symbol.rotatable || undefined,
    // Text typography lives once, in the `text` render layer's `text` object
    // (no duplicate top-level fontSize / per-layer fontSize+fontFamily).
    // The `symbol.textSymbol` bag on MapSymbol currently only carries
    // xmap-only fields (iconText) that OCD has no equivalent for —
    // dropping preserves OCD ↔ OMap convergence, and the direct xmap
    // round-trip preserves iconText via the writer's applyNativePassthroughs.
    // Same story for `symbol.areaSymbol.minArea`.
    layers: canonLayers.map(layer =>
      renderLayerToGitmap(layer, colorIds, symbolIds, canonLayers),
    ),
  }
}

function toGitmapObject(
  object: MapObject,
  symbolIds: Map<string | number, string>,
  partId = 'part_main',
  // Canonical z-order rank (the object's index in the map's render order).
  // Replaces the raw source-file object id as `sourceId`, so the SAME map from
  // OCD vs OMAP serialises identically — the source formats number objects
  // differently, but their z-order is the same, so the rank is canonical.
  zRank?: number,
) {
  const symbolId = symbolIds.get(object.symbolId) || String(object.symbolId)
  const rings = ringsToJson(object.coordinates || [])
  return {
    // Render order, as a canonical dense rank rather than the format-specific
    // source id (falls back to the raw id when no rank is supplied). The symbol
    // is referenced by `symbolId` (which is code-derived, e.g. sym_101, so the
    // code is already readable in a diff — no separate symbolCode needed).
    order: zRank ?? object.id,
    partId,
    symbolId,
    type: object.type,
    // The outer boundary; interior rings (holes) go in `holes`. Ring structure
    // is explicit, so no positional `hole` coord flag is stored.
    coordinates: rings.coordinates,
    holes: rings.holes,
    // Omit default/empty fields so the same object serialises identically no
    // matter which reader produced it (one format emits `text:""`/`rotation:0`/
    // a zero pattern, another omits them).
    text: object.text || undefined,
    rotation: rotationToGitmap(object.rotation) || undefined,
    hidden: object.hidden ? true : undefined,
    // Omit default alignment (0 = left / baseline): the OMap reader emits it
    // explicitly while the OCAD reader leaves it undefined, so dropping the
    // default makes the same label serialise identically. Non-default alignment
    // is preserved.
    hAlign: object.hAlign ? hAlignToGitmap(object.hAlign) : undefined,
    vAlign: object.vAlign ? vAlignToGitmap(object.vAlign) : undefined,
    textBox: object.textBox,
    pattern: cleanPattern(object.pattern),
    // A free-form per-object string payload with a type discriminator (OCAD's
    // "object string" — course/control codes, database links). Neutral names.
    tag: object.tag,
    tagType: object.tagType,
  }
}

// A pattern that is all-defaults (no rotation, origin at 0,0) carries no
// information — one format emits it explicitly, another omits it. Drop it so
// they match. The rotation is snapped to OCAD's 0.1° grid (like object
// rotation), since an OCD-sourced pattern angle is already quantised while an
// OMap-sourced copy keeps full float precision.
function cleanPattern(pattern: unknown): unknown {
  if (!pattern || typeof pattern !== 'object') return undefined
  const p = pattern as {
    rotation?: number
    origin?: { x?: number; y?: number }
  }
  const rotation = rotationToGitmap(p.rotation)
  const ox = p.origin?.x || 0
  const oy = p.origin?.y || 0
  if (rotation === 0 && ox === 0 && oy === 0) return undefined
  return { ...(pattern as object), rotation: rotation || undefined }
}

function renderLayerToGitmap(
  layer: RenderLayer,
  colorIds: Map<string | number, string>,
  symbolIds: Map<string | number, string> = new Map(),
  siblingLayers: RenderLayer[] = [],
) {
  const output: Record<string, unknown> = {}
  // Normalise cap+join per OCD's lineStyle-byte pairing rules BEFORE
  // dropping / mapping — OCD can't represent every combination, so
  // Mapper's OCAD export collapses `flat+round` → `flat+miter`,
  // `pointed+bevel` → `pointed+round`, and `round+*` → `round+round`.
  // Apply here so both source paths' gitmap output agrees even when
  // the source xmap set an "impossible" (cap, join) pair. Kept out of
  // the reader so xmap→panmap→xmap round-trips stay idempotent.
  layer = normaliseStrokeCapJoinForGitmap(layer)
  const drop = strokeCanonicalDrops(layer, siblingLayers)
  const layerType = (layer as { type?: string }).type

  Object.entries(layer).forEach(([key, value]) => {
    if (value === undefined) return
    if (drop.has(key)) return
    // OCAD stores symbol lengths as whole 0.01 mm units; Mapper stores µm
    // and so can express halves — the same decoration reaches us as
    // `endOffset: 188` from OCD and `187.5` from xmap. Round to OCAD's
    // grid, the coarser of the two and the only one both formats can
    // represent. Mapper does the same on its own OCD export (`qRound`),
    // which is why the OCD file holds 188 rather than 187.
    if (OCD_GRID_LENGTHS.has(key) && typeof value === 'number') {
      output[key] = Math.round(value)
      return
    }
    // Canonical colour reference is `colorId` everywhere; a layer that mirrored
    // its source with a bare `color` is renamed here.
    if (key === 'colorId' || key === 'color') {
      output.colorId = colorIds.get(value as string | number) || value
      return
    }
    // OCAD/Mapper integer enums → semantic strings (see ./enums).
    if (key === 'capStyle') {
      output[key] = capStyleToGitmap(value)
      return
    }
    if (key === 'joinStyle') {
      output[key] = joinStyleToGitmap(value)
      return
    }
    if (key === 'borders' && Array.isArray(value)) {
      output[key] = value.map(b => borderToGitmap(b, colorIds))
      return
    }
    // `border-symbol.symbolId` points to another map symbol. OCD stores the
    // referenced symbol's raw symNum (e.g. `301004`); OMap stores its own
    // internal id (e.g. `75`). Both resolve to the same real symbol
    // (`code: 301.4`), so remap through the canonical gitmap symbol id.
    if (layerType === 'border-symbol' && key === 'symbolId') {
      output[key] = symbolIds.get(value as string | number) || value
      return
    }
    if (layerType === 'text' && key === 'text') {
      output[key] = remapColors(
        toJsonSafe(canonicaliseTextBody(value)),
        colorIds,
      )
      return
    }
    // Text typography is authoritative in the nested `text` object; drop the
    // duplicated per-layer fontSize / fontFamily.
    if (layerType === 'text' && (key === 'fontSize' || key === 'fontFamily')) {
      return
    }
    // OCD encodes end/segment lengths as whole integers; OMap stores them
    // as floats (`endLength: 187.5` from xmap `end_length="1875"`). Round
    // for gitmap so both dialects agree — kura 105 Small earth wall was
    // otherwise diverging OCD 188 vs OMap 187.5 every round-trip.
    if (
      layerType === 'stroke' &&
      (key === 'endLength' || key === 'segmentLength') &&
      typeof value === 'number'
    ) {
      output[key] = Math.round(value)
      return
    }
    if (layerType === 'stroke' && key === 'dash') {
      output[key] = toJsonSafe(canonicaliseDash(value))
      return
    }
    if (key === 'elements' && Array.isArray(value)) {
      output[key] = value.map(elementToGitmap.bind(null, colorIds))
      return
    }
    if (
      [
        'primSymElements',
        'cornerSymElements',
        'startSymElements',
        'endSymElements',
      ].includes(key) &&
      Array.isArray(value)
    ) {
      output[key] = value.map(elementToGitmap.bind(null, colorIds))
      return
    }
    // Deep-remap color references inside nested structures such as
    // `pattern.symbol.pointSymbol.innerColor` — otherwise the raw
    // integer color ID leaks into gitmap and gitmap-read can no
    // longer resolve it against the (string-keyed) colors table.
    output[key] = remapColors(toJsonSafe(value), colorIds)
  })

  return output
}

/**
 * OCD's `lineStyle` byte encodes a fixed set of cap+join pairs, and
 * Mapper's OCD export additionally collapses several xmap join values
 * onto the byte's DEFAULT (bevel). Normalise on gitmap serialize so
 * the two source paths converge; kept out of the reader so
 * xmap→panmap→xmap round-trips remain idempotent.
 *
 * Rules (from Mapper's own ocd↔xmap corpus):
 *   • cap=round (1)                        → forces join=round (2)
 *   • cap=flat (0), join=round (2)         → substitutes join=miter (1)
 *   • cap=pointed (3), join=bevel (0)      → substitutes join=round (2)
 *   • join=miter (1) collapses to bevel (0) when the byte value would
 *     be the "default" (byte 0 for flat cap, byte 2 for pointed cap):
 *     Mapper's OCD-write picks the bevel-slot byte for many miter
 *     settings, so canonicalise both to bevel at the shared boundary.
 */
function normaliseStrokeCapJoinForGitmap(layer: RenderLayer): RenderLayer {
  if ((layer as { type?: string }).type !== 'stroke') return layer
  const l = layer as { capStyle?: number; joinStyle?: number } & Record<
    string,
    unknown
  >
  if (typeof l.capStyle !== 'number' || typeof l.joinStyle !== 'number') {
    return layer
  }
  const cap = l.capStyle
  let join = l.joinStyle
  if (cap === 1) join = 2
  else if (cap === 0 && join === 2) join = 1
  else if (cap === 3 && join === 0) join = 2
  // Miter → bevel collapse. Mapper's OCD export writes miter (join 1)
  // into the bevel-slot byte for most symbols in the corpus, so an
  // OCD-sourced sibling reads back as bevel (join 0) where the xmap
  // says miter. Canonicalise to bevel so both sources agree.
  if (join === 1) join = 0
  if (cap === l.capStyle && join === l.joinStyle) return layer
  return { ...l, capStyle: cap, joinStyle: join } as RenderLayer
}

export {
  toGitmapColor,
  toGitmapSymbol,
  toGitmapObject,
  stableColorId,
  stableSymbolId,
  coordinatesToJson,
}
