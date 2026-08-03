import crypto from 'node:crypto'
import type { MapColor, MapObject, MapSymbol, RenderLayer } from '../../map/model.js'

function toGitmapColor(color: MapColor) {
  return {
    id: stableColorId(color),
    sourceId: color.sourceId ?? color.id,
    name: color.name || '',
    rgb: color.rgb,
    // OCAD-side rendering uses CMYK, not RGB — persist it in gitmap so
    // a gitmap → ocd round-trip preserves ink density. Without this,
    // gitmap-sourced OCD exports lose CMYK, and every color falls
    // back to [0,0,0,0] = no ink = a completely white map in Mapper.
    cmyk: color.cmyk,
    opacity: color.opacity,
    renderOrder: (color.renderOrder ?? 0) * 1000,
  }
}

function toGitmapSymbol(symbol: MapSymbol, colorIds: Map<string | number, string>) {
  return {
    id: stableSymbolId(symbol),
    sourceId: symbol.sourceId ?? symbol.id,
    code: symbol.code,
    name: symbol.name,
    type: symbol.type,
    // Omit boolean fields that equal their default so a semantic toggle
    // shows up in `git diff` as a real field add, not a value swap.
    hidden: symbol.hidden ? true : undefined,
    rotatable: symbol.rotatable || undefined,
    fontSize: symbol.fontSize,
    textSymbol: toJsonSafe(symbol.textSymbol),
    renderLayers: (symbol.renderLayers || []).map(layer =>
      renderLayerToGitmap(layer, colorIds)
    ),
  }
}

function toGitmapObject(
  object: MapObject,
  symbolIds: Map<string | number, string>,
  symbolCodes: Map<string | number, string>,
  partId = 'part_main',
) {
  const symbolId = symbolIds.get(object.symbolId) || String(object.symbolId)
  const symbolCode = symbolCodes.get(object.symbolId)
  return {
    id: stableObjectId(object, symbolId, partId),
    sourceId: object.id,
    partId,
    symbolId,
    // Denormalised from the referenced symbol so `git diff` on
    // objects.ndjson is readable without cross-referencing symbols.ndjson.
    symbolCode,
    type: object.type,
    coordinates: coordinatesToJson(object.coordinates || []),
    text: object.text,
    rotation: object.rotation,
    hidden: object.hidden ? true : undefined,
    hAlign: object.hAlign,
    vAlign: object.vAlign,
    textBox: object.textBox,
    pattern: object.pattern,
    objectString: object.objectString,
    objectStringType: object.objectStringType,
  }
}

function renderLayerToGitmap(
  layer: RenderLayer,
  colorIds: Map<string | number, string>
) {
  const output: Record<string, unknown> = {}

  Object.entries(layer).forEach(([key, value]) => {
    if (value === undefined) return
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

function coordinatesToJson(coordinates: unknown[]): unknown[] {
  return coordinates.map(coordToJson)
}

/**
 * Serialise a coordinate.
 *
 * Always emits `{x, y, ...nonZeroFlags}` for schema consistency. Zero-
 * valued flag fields are omitted so plain coords stay compact — that's
 * where the diff-noise reduction comes from, not from switching shapes.
 */
function coordToJson(coord: unknown): unknown {
  const src = coord as {
    0?: number; 1?: number; x?: number; y?: number;
    flags?: number; xFlags?: number; yFlags?: number; omapFlags?: number;
  }
  const isTuple = Array.isArray(coord)
  const x = cleanNumber(isTuple ? src[0] : src.x)
  const y = cleanNumber(isTuple ? src[1] : src.y)

  const out: Record<string, unknown> = { x, y }
  if (src.flags) out.flags = src.flags
  if (src.xFlags) out.xFlags = src.xFlags
  if (src.yFlags) out.yFlags = src.yFlags
  if (src.omapFlags) out.omapFlags = src.omapFlags
  return out
}

function toJsonSafe(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toJsonSafe)
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
  const code = symbol.code || String(symbol.sourceId ?? symbol.id)
  return `sym_${slug(code)}`
}

function stableObjectId(
  object: MapObject,
  symbolId?: string,
  partId = 'part_main',
): string {
  return `obj_${hashObject({
    partId,
    symbolId: symbolId || object.symbolId,
    type: object.type,
    coordinates: coordinatesToIdentityJson(object.coordinates || []),
    text: object.text || '',
    rotation: object.rotation || 0,
  })}`
}

function coordinatesToIdentityJson(coordinates: unknown[]): unknown[] {
  return coordinates.map(coord => {
    const src = coord as { 0?: number; 1?: number; x?: number; y?: number }
    const isTuple = Array.isArray(coord)
    if (!isTuple && (!coord || typeof coord !== 'object' || !('x' in src))) {
      return coord
    }
    return {
      x: cleanNumber(isTuple ? src[0] : src.x),
      y: cleanNumber(isTuple ? src[1] : src.y),
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
