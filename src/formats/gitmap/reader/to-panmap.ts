/**
 * GitMap → Panmap: map the parsed gitmap records (manifest + colours/symbols/
 * objects + optional private view/print) into the canonical model. The bytes
 * are read and parsed in `./index.ts`; this file only maps already-parsed data,
 * symmetric with the ocad/omap `to-panmap` stages.
 */
import Panmap from '../../../panmap/model.js'
import type { RenderLayer } from '../../../panmap/render-layers.js'
import { boundsForCoords } from '../../../panmap/coord.js'
import {
  capStyleFromGitmap,
  joinStyleFromGitmap,
  hAlignFromGitmap,
  vAlignFromGitmap,
  rotationFromGitmap,
} from '../codecs/index.js'

/** Parsed gitmap package: the raw records `./index.ts` reads off a source. */
export interface GitmapFile {
  manifest: any
  colors: any[]
  symbols: any[]
  objects: any[]
  privateData?: Record<string, unknown>
  /** Human-readable origin (directory path or "bundle") for `sourceFile`. */
  label: string
}

/** A colour record as it appears in a gitmap `colors.ndjson` line. */
interface GitmapColor {
  id: number | string
  order: number | string
  name?: string
  /** `[r, g, b]` integer array. */
  rgb?: unknown
  cmyk?: [number, number, number, number]
  opacity?: number
  renderOrder?: number
}

/** A symbol record as it appears in a gitmap `symbols.ndjson` line. */
interface GitmapSymbol {
  id: number | string
  code?: string
  name?: string
  type: string
  hidden?: boolean
  rotatable?: boolean
  textSymbol?: { rotatable?: boolean; fontSize?: number }
  layers?: unknown[]
}

/** An object record as it appears in a gitmap `objects.ndjson` line. */
interface GitmapObject {
  order?: number
  partId?: string
  symbolId: number | string
  type: string
  coordinates?: unknown[]
  holes?: unknown
  text?: string
  /** Degrees; converted to radians by `rotationFromGitmap`. */
  rotation?: unknown
  hidden?: boolean
  hAlign?: unknown
  vAlign?: unknown
  textBox?: { width: number; height: number }
  pattern?: unknown
  tag?: string
  tagType?: number
}

export default function gitmapToPanmap(file: GitmapFile): Panmap {
  const { manifest, colors, symbols, objects, privateData, label } = file

  // `view` / `print` live under `private/` for gitignoring editor state.
  const view = pickObject(privateData?.view)
  const print = pickObject(privateData?.print)

  const symbolIds = new Map<string | number, string | number>(
    symbols.map(symbol => [symbol.id, symbol.id]),
  )

  // Parts only matter for multi-part maps; a lone default part stays implicit.
  const gitmapParts = Array.isArray(manifest.parts) ? manifest.parts : []
  const multiPart = gitmapParts.length > 1
  const parts = multiPart
    ? gitmapParts.map((part: { id: unknown; name?: unknown }) => ({
        id: String(part.id),
        name: typeof part.name === 'string' ? part.name : undefined,
      }))
    : undefined

  return new Panmap({
    sourceFormat: 'gitmap',
    sourceFile: { directory: label, manifest },
    metadata: { gitmap: manifest },
    colors: colors.map(colorFromGitmap),
    symbols: symbols.map((symbol, i) => symbolFromGitmap(symbol, i)),
    // Preserve source rendering order: gitmap files are sorted by
    // (partId, symbolId, id) for deterministic git diffs, which loses
    // the original OMap/OCAD document order. `order` is the object's
    // canonical z-rank, so sorting on it restores render order.
    objects: sortBySourceId(
      objects.map((object, i) =>
        objectFromGitmap(object, symbolIds, i, multiPart),
      ),
    ) as any, // order-preserving reorder; MapObject typing is nominal here
    parts,
    warnings: [],
    extensions:
      manifest.extensions && typeof manifest.extensions === 'object'
        ? manifest.extensions
        : {},
    notes: typeof manifest.notes === 'string' ? manifest.notes : '',
    view: view as Panmap['view'] | undefined,
    print: print as Panmap['print'] | undefined,
    templates:
      manifest.templates && typeof manifest.templates === 'object'
        ? (manifest.templates as Panmap['templates'])
        : undefined,
    georeferencing:
      manifest.georeferencing && typeof manifest.georeferencing === 'object'
        ? (manifest.georeferencing as Panmap['georeferencing'])
        : undefined,
  })
}

function pickObject(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined
}

function sortBySourceId<T extends { sourceId?: unknown }>(objects: T[]): T[] {
  return objects.slice().sort((a, b) => {
    const sa = numericIfPossible(a.sourceId)
    const sb = numericIfPossible(b.sourceId)
    if (typeof sa === 'number' && typeof sb === 'number') return sa - sb
    return String(a.sourceId ?? '').localeCompare(String(b.sourceId ?? ''))
  })
}

function numericIfPossible(v: unknown): number | string {
  if (typeof v === 'number') return v
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return Number(v)
  return String(v ?? '')
}

function colorFromGitmap(color: GitmapColor) {
  return {
    id: color.id,
    sourceId: color.order,
    name: color.name || '',
    // A valid gitmap colour always has an [r,g,b] array → a string here.
    rgb: rgbToString(color.rgb) as string,
    cmyk: color.cmyk,
    opacity: color.opacity,
    renderOrder: color.renderOrder ?? 0,
  }
}

// gitmap stores rgb as an [r, g, b] integer array; the model uses a CSS rgb()
// string (the SVG exporter renders it directly).
function rgbToString(rgb: unknown): string | undefined {
  if (Array.isArray(rgb) && rgb.length >= 3) {
    return `rgb(${Math.round(rgb[0])}, ${Math.round(rgb[1])}, ${Math.round(rgb[2])})`
  }
  return undefined
}

function symbolFromGitmap(symbol: GitmapSymbol, index = 0) {
  const layers = symbol.layers ?? []
  return {
    id: symbol.id,
    // symbols.ndjson has no stored `order` — it was just the code-sorted line
    // position (derivable, and it diverged cross-format when the two exports'
    // symbol sets differed). Re-derive the same value from the read index; the
    // OCD/OMap writers use it only as a numbering fallback.
    sourceId: index,
    code: symbol.code,
    name: symbol.name,
    type: symbol.type,
    hidden: !!symbol.hidden,
    rotatable: !!symbol.rotatable,
    // Typography is authoritative in the text layer; surface fontSize on the
    // model for the OCAD/OMap writers.
    fontSize: fontSizeFromLayers(layers),
    textSymbol: symbol.textSymbol,
    layers: layers.map(renderLayerFromGitmap),
  }
}

function fontSizeFromLayers(layers: unknown[]): number | undefined {
  for (const l of layers || []) {
    const layer = l as {
      type?: string
      text?: { fontSize?: number }
      fontSize?: number
    }
    if (layer.type === 'text') return layer.text?.fontSize ?? layer.fontSize
  }
  return undefined
}

function objectFromGitmap(
  object: GitmapObject,
  symbolIds: Map<string | number, string | number>,
  index = 0,
  multiPart = false,
) {
  const coordinates = ringsFromGitmap(object.coordinates || [], object.holes)
  return {
    // Gitmap stores no object id (objects.ndjson is geometry-sorted, not
    // id-keyed); use the canonical z-rank as the stable in-memory handle.
    id: object.order ?? index,
    sourceId: object.order,
    // Part membership only surfaces for genuine multi-part maps; a single
    // part is the implicit default and leaves `partId` undefined.
    partId: multiPart ? object.partId : undefined,
    symbolId: symbolIds.get(object.symbolId) || object.symbolId,
    type: object.type,
    coordinates,
    text: object.text,
    rotation: rotationFromGitmap(object.rotation),
    hidden: !!object.hidden,
    hAlign: hAlignFromGitmap(object.hAlign),
    vAlign: vAlignFromGitmap(object.vAlign),
    textBox: object.textBox,
    pattern: patternFromGitmap(object.pattern),
    tag: object.tag,
    tagType: object.tagType,
    bounds: boundsForCoords(coordinates),
  }
}

function renderLayerFromGitmap(layer: unknown): RenderLayer {
  const output = { ...(layer as Record<string, unknown>) }
  // Reverse the canonical enum strings back to the model's OCAD/Mapper ints.
  if (output.capStyle !== undefined)
    output.capStyle = capStyleFromGitmap(output.capStyle)
  if (output.joinStyle !== undefined)
    output.joinStyle = joinStyleFromGitmap(output.joinStyle)
  if (Array.isArray(output.borders))
    output.borders = output.borders.map(borderFromGitmap)
  if (Array.isArray(output.elements)) {
    output.elements = output.elements.map(elementFromGitmap)
  }
  ;(
    [
      'primSymElements',
      'cornerSymElements',
      'startSymElements',
      'endSymElements',
    ] as const
  ).forEach(key => {
    const arr = output[key]
    if (Array.isArray(arr)) {
      output[key] = arr.map(elementFromGitmap)
    }
  })
  return output as unknown as RenderLayer
}

// A stroke casing line: restore the model's `color` field from `colorId`.
function borderFromGitmap(border: unknown) {
  if (
    !border ||
    typeof border !== 'object' ||
    (border as Record<string, unknown>).colorId === undefined
  )
    return border
  const { colorId, ...rest } = border as Record<string, unknown>
  return { color: colorId, ...rest }
}

function elementFromGitmap(element: unknown) {
  const output = { ...(element as Record<string, unknown>) }
  // Restore the model field names the OCD/OMap writers expect: gitmap renamed
  // color→colorId and coords→coordinates and dropped the derived numberCoords
  // (= coordinates.length).
  if (output.colorId !== undefined) {
    output.color = output.colorId
    delete output.colorId
  }
  if (output.radius !== undefined) {
    output.diameter = (output.radius as number) * 2
    delete output.radius
  }
  const coordSrc = Array.isArray(output.coordinates)
    ? output.coordinates
    : Array.isArray(output.coords)
      ? output.coords
      : undefined
  if (coordSrc) {
    const coords = coordsFromGitmap(coordSrc)
    output.coords = coords
    delete output.coordinates
    output.numberCoords = coords.length
  }
  return output
}

// Object/pattern rotation is stored in degrees in gitmap; the model uses
// radians. Convert the pattern override's rotation back on read.
function patternFromGitmap(pattern: unknown) {
  if (
    !pattern ||
    typeof pattern !== 'object' ||
    (pattern as Record<string, unknown>).rotation === undefined
  )
    return pattern
  return {
    ...pattern,
    rotation: rotationFromGitmap((pattern as Record<string, unknown>).rotation),
  }
}

type CoordArray = Array<number> & { xFlags?: number; yFlags?: number }

// Rebuild the model's flat coordinate list from explicit rings: the outer
// `coordinates` plus each `holes` ring, concatenated. Ring boundaries are
// restored by setting the hole bit (yFlags 0x02) on the LAST coord of every ring
// except the last — the inverse of the writer's `ringsToJson` split. Bézier
// control-runs never cross a ring, so each ring is parsed independently.
function ringsFromGitmap(outer: unknown[], holes: unknown): CoordArray[] {
  const rings = [outer, ...(Array.isArray(holes) ? (holes as unknown[][]) : [])]
  const flat: CoordArray[] = []
  rings.forEach((ring, ri) => {
    const coords = coordsFromGitmap(ring)
    if (ri < rings.length - 1 && coords.length > 0) {
      const last = coords[coords.length - 1]
      last.yFlags = (last.yFlags ?? 0) | 0x02
    }
    flat.push(...coords)
  })
  return flat
}

// Parse a coord list of tuples: `[x, y]` or `[x, y, {control?, corner?, hole?,
// dash?}]`. Both object coordinates and element (icon) coords use this shape.
// Semantic flags translate back to OCAD's xFlags/yFlags; `control` points come in
// pairs, so the first in a run is cp1 (0x01), the second cp2 (0x02). Object coords
// never carry `hole` (their rings are structural); element coords may.
function coordsFromGitmap(coords: unknown[]): CoordArray[] {
  let controlRun = 0
  return (coords || []).map((c): CoordArray => {
    if (!Array.isArray(c)) return c as CoordArray
    const flags =
      c.length > 2 && c[2] && typeof c[2] === 'object'
        ? (c[2] as Record<string, unknown>)
        : undefined
    let xFlags = 0
    let yFlags = 0
    if (flags?.control) {
      controlRun += 1
      xFlags |= controlRun % 2 === 1 ? 0x01 : 0x02
    } else controlRun = 0
    if (flags?.corner) yFlags |= 0x01
    if (flags?.hole) yFlags |= 0x02
    if (flags?.dash) yFlags |= 0x08
    const tuple = [Number(c[0]), Number(c[1])] as CoordArray
    if (xFlags) tuple.xFlags = xFlags
    if (yFlags) tuple.yFlags = yFlags
    return tuple
  })
}
