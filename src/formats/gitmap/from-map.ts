import crypto from 'node:crypto'
import type { MapColor, MapObject, MapSymbol, RenderLayer } from '../../map/model.js'
import { snapRotationToOcadGrid } from '../codecs/index.js'
import { canonicalSymbolCode } from '../../util/symbol-code.js'

function toGitmapColor(color: MapColor) {
  return {
    id: stableColorId(color),
    sourceId: color.sourceId ?? color.id,
    name: color.name || '',
    // RGB to 6 dp (well under 8-bit precision) to drop float-conversion noise.
    rgb: roundTuple(color.rgb, 6),
    // OCAD-side rendering uses CMYK, not RGB — persist it in gitmap so a
    // gitmap → ocd round-trip preserves ink density. OCAD stores CMYK as whole
    // percentages, so snap to that grid (2 dp): an OCD-sourced colour is already
    // quantised while an OMap-sourced copy keeps half-percent values (0.135 vs
    // 0.14) — snapping makes them agree, below OCAD's own resolution.
    cmyk: roundTuple(color.cmyk, 2),
    opacity: color.opacity,
    renderOrder: (color.renderOrder ?? 0) * 1000,
  }
}

function roundTuple(tuple: unknown, dp: number): unknown {
  if (!Array.isArray(tuple)) return tuple
  const f = 10 ** dp
  return tuple.map(v => (typeof v === 'number' ? Math.round(v * f) / f : v))
}

// OCAD models an area-with-outline as an `area` symbol + a border line; OMap
// models the same thing as a `combined` symbol (area part + line ref). Both
// readers build the identical `fill` + `border-symbol` render layers — only the
// container type label differs. Canonicalise the pair to `combined`.
function canonicalSymbolType(symbol: MapSymbol): string | undefined {
  const layers = symbol.renderLayers || []
  const hasBorder = layers.some(l => l.type === 'border-symbol')
  const hasFill = layers.some(
    l => l.type === 'fill' || l.type === 'hatch-fill' || l.type === 'point-pattern-fill'
  )
  if (hasFill && hasBorder && (symbol.type === 'area' || symbol.type === 'combined')) {
    return 'combined'
  }
  return symbol.type
}

// A `point-fill`/`point-stroke` layer whose colour id is invalid (< 0 or unset)
// renders nothing — the SVG renderer's `isValidColorId` gate returns null. The
// OMap reader emits such phantom layers (e.g. a disc with colorId -1) where the
// OCAD reader emits none, so dropping them canonicalises the layer set without
// changing what's drawn.
function isPhantomFillLayer(layer: RenderLayer): boolean {
  const l = layer as { type?: string; colorId?: unknown; color?: unknown }
  if (l.type !== 'point-fill' && l.type !== 'point-stroke') return false
  const id = l.colorId ?? l.color
  if (id === null || id === undefined) return true
  if (typeof id === 'number') return id < 0
  if (typeof id === 'string') return id.length === 0
  return true
}

function toGitmapSymbol(symbol: MapSymbol, colorIds: Map<string | number, string>) {
  return {
    id: stableSymbolId(symbol),
    sourceId: symbol.sourceId ?? symbol.id,
    code: canonicalSymbolCode(symbol.code) || undefined,
    name: symbol.name,
    type: canonicalSymbolType(symbol),
    // Omit boolean fields that equal their default so a semantic toggle
    // shows up in `git diff` as a real field add, not a value swap.
    hidden: symbol.hidden ? true : undefined,
    rotatable: symbol.rotatable || undefined,
    fontSize: symbol.fontSize == null ? undefined : cleanNumber(symbol.fontSize),
    textSymbol: toJsonSafe(symbol.textSymbol),
    renderLayers: (symbol.renderLayers || [])
      .filter(layer => !isPhantomFillLayer(layer))
      .map(layer =>
      renderLayerToGitmap(layer, colorIds)
    ),
  }
}

function toGitmapObject(
  object: MapObject,
  symbolIds: Map<string | number, string>,
  symbolCodes: Map<string | number, string>,
  partId = 'part_main',
  // Negate object-coordinate Y so an OCAD-sourced (y-up) map is stored in
  // gitmap's canonical visual (y-down) space — matching omap output and the
  // SVG exporter's `getVisualCoordinateTransform`. Only object coordinates
  // are flipped, exactly as the omap writer's `flipY` does; symbol geometry
  // is left untouched. Without this an ocd→gitmap conversion stores coords
  // upside-down vs every omap-sourced gitmap, so a diff between them reports
  // 100% of the map as changed.
  flipY = false,
  // Canonical z-order rank (the object's index in the map's render order).
  // Replaces the raw source-file object id as `sourceId`, so the SAME map from
  // OCD vs OMAP serialises identically — the source formats number objects
  // differently, but their z-order is the same, so the rank is canonical.
  zRank?: number,
) {
  const symbolId = symbolIds.get(object.symbolId) || String(object.symbolId)
  const symbolCode = symbolCodes.get(object.symbolId)
  return {
    id: stableObjectId(object, symbolId, partId, flipY),
    // Render order, as a canonical dense rank rather than the format-specific
    // source id (falls back to the raw id when no rank is supplied).
    sourceId: zRank ?? object.id,
    partId,
    symbolId,
    // Denormalised from the referenced symbol so `git diff` on
    // objects.ndjson is readable without cross-referencing symbols.ndjson.
    symbolCode,
    type: object.type,
    coordinates: coordinatesToJson(object.coordinates || [], flipY),
    // Omit default/empty fields so the same object serialises identically no
    // matter which reader produced it (one format emits `text:""`/`rotation:0`/
    // a zero pattern, another omits them). The id hash already normalises these
    // to their defaults, so omitting them here changes bytes, not identity.
    text: object.text || undefined,
    rotation: snapRotationToOcadGrid(object.rotation) || undefined,
    hidden: object.hidden ? true : undefined,
    // Omit default alignment (0 = left / baseline): the OMap reader emits it
    // explicitly while the OCAD reader leaves it undefined, so dropping the
    // default makes the same label serialise identically. Non-default alignment
    // is preserved.
    hAlign: object.hAlign || undefined,
    vAlign: object.vAlign || undefined,
    textBox: object.textBox,
    pattern: cleanPattern(object.pattern),
    objectString: object.objectString,
    objectStringType: object.objectStringType,
  }
}

// A pattern that is all-defaults (no rotation, origin at 0,0) carries no
// information — one format emits it explicitly, another omits it. Drop it so
// they match. The rotation is snapped to OCAD's 0.1° grid (like object
// rotation), since an OCD-sourced pattern angle is already quantised while an
// OMap-sourced copy keeps full float precision.
function cleanPattern(pattern: unknown): unknown {
  if (!pattern || typeof pattern !== 'object') return undefined
  const p = pattern as { rotation?: number; origin?: { x?: number; y?: number } }
  const rotation = snapRotationToOcadGrid(p.rotation)
  const ox = p.origin?.x || 0
  const oy = p.origin?.y || 0
  if (rotation === 0 && ox === 0 && oy === 0) return undefined
  return { ...(pattern as object), rotation: rotation || undefined }
}

// Fields to drop when canonicalising a `stroke` render layer, so an OCD- and an
// OMap-sourced copy of the same line serialise identically. The OCAD reader
// emits `lineStyle` (a packed cap+join byte that `capStyle`/`joinStyle` already
// carry, and that the SVG renderer ignores) and gates zero offsets to
// undefined; the OMap reader omits `lineStyle` but always emits the zero
// defaults. Dropping `lineStyle` + the defaults reconciles both. Non-default
// values are kept (a stroke that genuinely offsets or hides its mid-symbol).
function strokeCanonicalDrops(layer: RenderLayer): ReadonlySet<string> {
  if ((layer as { type?: string }).type !== 'stroke') return EMPTY_DROP
  const l = layer as Record<string, unknown>
  const drop = new Set<string>(['lineStyle'])
  if (!l.minimumMidSymbolCount) drop.add('minimumMidSymbolCount')
  if (l.showAtLeastOneSymbol === true || l.showAtLeastOneSymbol === undefined) {
    drop.add('showAtLeastOneSymbol')
  }
  if (!l.startOffset) drop.add('startOffset')
  if (!l.endOffset) drop.add('endOffset')
  if (!l.endLength) drop.add('endLength')
  return drop
}

const EMPTY_DROP: ReadonlySet<string> = new Set()

function renderLayerToGitmap(
  layer: RenderLayer,
  colorIds: Map<string | number, string>
) {
  const output: Record<string, unknown> = {}
  const drop = strokeCanonicalDrops(layer)

  Object.entries(layer).forEach(([key, value]) => {
    if (value === undefined) return
    if (drop.has(key)) return
    if (key === 'colorId' || key === 'color') {
      output[key] = colorIds.get(value as string | number) || value
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

// Keys that hold color-id references anywhere in the symbol tree.
const COLOR_ID_KEYS = new Set([
  'color', 'colorId',
  'innerColor', 'outerColor',
  'fillColor', 'leftColor', 'rightColor',
  'hatchColor',
])

function remapColors(
  node: unknown,
  colorIds: Map<string | number, string>,
): unknown {
  if (Array.isArray(node)) {
    return node.map(child => remapColors(child, colorIds))
  }
  if (!node || typeof node !== 'object') return node
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (COLOR_ID_KEYS.has(k) && (typeof v === 'number' || typeof v === 'string')) {
      out[k] = colorIds.get(v as string | number) ?? v
    } else {
      out[k] = remapColors(v, colorIds)
    }
  }
  return out
}

function elementToGitmap(colorIds: Map<string | number, string>, element) {
  const output: Record<string, unknown> = {}
  Object.entries(element).forEach(([key, value]) => {
    if (value === undefined) return
    if (key === 'color') {
      output[key] = colorIds.get(value as string | number) || value
      return
    }
    if (key === 'coords') {
      output[key] = coordinatesToJson(value as unknown[])
      return
    }
    // XMap-style element.symbol carries a full nested symbol tree
    // (areaSymbol / lineSymbol / pointSymbol) with its own color
    // references — recurse via remapColors, not toJsonSafe, so those
    // integer ids get lifted to the PanMap string ids.
    output[key] = remapColors(toJsonSafe(value), colorIds)
  })
  return output
}

function coordinatesToJson(coordinates: unknown[], flipY = false): unknown[] {
  return coordinates.map(coord => coordToJson(coord, flipY))
}

/**
 * Serialise a coordinate.
 *
 * Always emits `{x, y, ...nonZeroFlags}` for schema consistency. Zero-
 * valued flag fields are omitted so plain coords stay compact — that's
 * where the diff-noise reduction comes from, not from switching shapes.
 */
function coordToJson(coord: unknown, flipY = false): unknown {
  const src = coord as {
    0?: number; 1?: number; x?: number; y?: number;
    flags?: number; xFlags?: number; yFlags?: number; omapFlags?: number;
  }
  const isTuple = Array.isArray(coord)
  const x = cleanNumber(isTuple ? src[0] : src.x)
  const rawY = cleanNumber(isTuple ? src[1] : src.y)
  // Negate for the visual (y-down) space; avoid -0 so serialisation is stable.
  const y = flipY && rawY !== 0 ? -rawY : rawY

  const out: Record<string, unknown> = { x, y }
  if (src.flags) out.flags = src.flags
  if (src.xFlags) out.xFlags = src.xFlags
  if (src.yFlags) out.yFlags = src.yFlags
  // `omapFlags` (the raw OMap flag byte) is deliberately NOT emitted: it's
  // source-format round-trip data that makes an OMap-sourced coordinate differ
  // from the byte-identical OCD-sourced one. The canonical semantic flags
  // (bezier / corner / hole / dash) live in xFlags/yFlags, which both readers
  // populate; the omap writer re-derives its byte from those.
  return out
}

function toJsonSafe(value: unknown): unknown {
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

function stableColorId(color: MapColor): string {
  // Include a stable disambiguator so duplicate-named color slots
  // (port-hills has 6 different "Green" entries used at different
  // render orders) don't collapse into one gitmap id. Renumber via
  // sourceId when present, else id — either is stable across a
  // single map's serialisation.
  const base = slug(color.name || String(color.id)) || String(color.id)
  const disc = color.sourceId ?? color.id
  return `color_${base}_${disc}`
}

function stableSymbolId(symbol: MapSymbol): string {
  const code = canonicalSymbolCode(symbol.code) || String(symbol.sourceId ?? symbol.id)
  return `sym_${slug(code)}`
}

function stableObjectId(
  object: MapObject,
  symbolId?: string,
  partId = 'part_main',
  flipY = false,
): string {
  return `obj_${hashObject({
    partId,
    symbolId: symbolId || object.symbolId,
    type: object.type,
    // Hash the SAME (possibly y-flipped) coords that get serialised, so the
    // id identifies the geometry as actually stored.
    coordinates: coordinatesToIdentityJson(object.coordinates || [], flipY),
    text: object.text || '',
    rotation: snapRotationToOcadGrid(object.rotation),
  })}`
}

function coordinatesToIdentityJson(coordinates: unknown[], flipY = false): unknown[] {
  return coordinates.map(coord => {
    const src = coord as { 0?: number; 1?: number; x?: number; y?: number }
    const isTuple = Array.isArray(coord)
    if (!isTuple && (!coord || typeof coord !== 'object' || !('x' in src))) {
      return coord
    }
    const rawY = cleanNumber(isTuple ? src[1] : src.y)
    return {
      x: cleanNumber(isTuple ? src[0] : src.x),
      y: flipY && rawY !== 0 ? -rawY : rawY,
    }
  })
}

function slug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

function hashObject(value: unknown): string {
  return crypto
    .createHash('sha1')
    .update(JSON.stringify(toJsonSafe(value)))
    .digest('hex')
    .slice(0, 12)
}

function cleanNumber(value: unknown): number {
  const number = Number(value)
  return Number.isInteger(number) ? number : Number(number.toFixed(3))
}

export {
  toGitmapColor,
  toGitmapSymbol,
  toGitmapObject,
  stableColorId,
  stableSymbolId,
  stableObjectId,
  coordinatesToJson,
}
